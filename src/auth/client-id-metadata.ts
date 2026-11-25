/**
 * Client ID Metadata Documents (#46, ADR-0002 D14): a client may use an https
 * URL as its `client_id`, and this server fetches the client's metadata from
 * that URL instead of requiring `/register` (MCP spec 2026-07-28 deprecates
 * Dynamic Client Registration in favour of this).
 *
 * oidc-provider's experimental `clientIdMetadataDocument` feature does the
 * protocol (provider.ts turns it on, off by default, with
 * `MCP_CLIENT_ID_METADATA_DOCUMENTS`): it recognizes a URL-form `client_id`,
 * refuses one equal to the issuer, checks that the document's `client_id` is
 * the URL, refuses shared-secret authentication methods and `client_secret`,
 * deduplicates concurrent fetches of one URL, caches a document for its
 * `Cache-Control` max-age within {@link CACHE_DURATION_SEC}, and advertises
 * `client_id_metadata_document_supported`. This module is the rest:
 *
 *   - **Our own fetch** ({@link fetchMetadataDocument}), never the library's
 *     default `globalThis.fetch`:
 *       - https only, on the default port, with no userinfo or fragment;
 *       - the host is resolved once, and every address it resolves to must be
 *         public unicast ({@link isSpecialUseAddress}: private, loopback,
 *         link-local, CGNAT, multicast, unspecified, documentation and other
 *         reserved ranges are refused, IPv4 and IPv6, IPv4-mapped IPv6
 *         included). The connection then goes only to the addresses that were
 *         checked (a pinned `lookup` that answers the checked set, tried in
 *         turn so an unreachable one falls back to the next), with the URL's
 *         host as Host and SNI, so a DNS answer that changes between the check
 *         and the connection (DNS rebinding) can't move it; the socket's peer
 *         address must be one of the checked set once connected;
 *       - no redirect is followed: anything but 200 is refused;
 *       - the body is capped at {@link MAX_DOCUMENT_BYTES}, counted as it
 *         streams, and resolution, connection and body all share one deadline
 *         ({@link FETCH_TIMEOUT_MS}; the library's own 2.5 s signal also
 *         applies, so the shorter wins).
 *   - **The same rules as `/register`** ({@link normalizeMetadataDocument}): a
 *     document must pass dcr-validator's {@link registrableMetadata} (the
 *     redirect-URI policy: 1 to 5 URIs, https or loopback http, private-use
 *     schemes from `MCP_DCR_PRIVATE_USE_SCHEMES`; the client-name rules), and
 *     the library is handed only the fields a registration keeps, normalized
 *     the same way (so a loopback-only client is `native` and gets the
 *     loopback port relaxation, and `scope` is dropped). `MCP_VERIFIED_REDIRECT_URIS`
 *     and `MCP_TRUST_LOOPBACK_REDIRECTS` then apply at /authorize exactly as
 *     for a registered client. A metadata-document client is always public
 *     (`token_endpoint_auth_method: none`).
 *   - **A failure cache**: a URL whose fetch or document failed is refused
 *     without a fetch for {@link FAILURE_TTL_MS}. The library caches only
 *     successes, and an /authorize request looks a client up twice (in
 *     authorize-validation, then in the library), so without it a bad URL would
 *     be fetched twice per request.
 *   - **A per-IP fetch budget** ({@link FETCH_RATE_LIMIT} per
 *     {@link FETCH_RATE_WINDOW_MS}), so nobody can make this server fetch
 *     arbitrary URLs at speed. Only real fetches count: a cached document
 *     never reaches `allowFetch`. The requester is known from the
 *     `cimd-context` stage ({@link requesterContext}), because the first
 *     lookup happens in our own stages, outside the library's request context.
 *     A refusal for being over budget is never put in the failure cache: one
 *     address over its budget must not refuse that client for everyone.
 *
 * Every refusal reaches the client as the library's `invalid_client`, with
 * its fixed description: nothing fetched, and no address, is ever echoed. The
 * reason ({@link MetadataDocumentFailure}) is logged once per failure-cache
 * entry, with the URL's host only.
 *
 * **#64a:** a metadata-document client counts as registered on 0.5.0 or later
 * (lead decision), so it must send `resource`. It has no
 * `client_id_issued_at`; isMetadataDocumentClientId (./client-id-url.ts)
 * tells it apart.
 *
 * **State** is in memory (the library's cache, the failure cache, the
 * default limiter store), so several instances each fetch and cache on their
 * own. The one stored row is the client's anchor in `oauth_rows`, written when
 * its first code is saved (src/auth/oidc/adapter.ts), because storage saves a
 * code only for a client that has a row. No migration.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { MemoryStore, type Options as RateLimitOptions, type Store } from 'express-rate-limit';
import { registrableMetadata } from './dcr-validator.js';
import type { ClientMetadataPolicy } from './client-metadata.js';
import type { LimiterStoreFactory } from '../middleware/rate-limiters.js';
import { clientIp, type ClientKeyOptions } from '../middleware/rate-limit-key.js';

/** The draft of the library's experimental feature this code was written against (its required `ack`). */
export const CIMD_ACK = 'draft-03';

/** The largest metadata document accepted, in bytes, counted as it streams. */
export const MAX_DOCUMENT_BYTES = 16 * 1024;

/** One deadline for resolving, connecting and reading the whole document. */
export const FETCH_TIMEOUT_MS = 5_000;

/** How long a fetched document is cached: its `Cache-Control` max-age, within these bounds (seconds). */
export const CACHE_DURATION_SEC = { min: 300, max: 86_400 } as const;

/** How long a URL whose fetch or document failed is refused without a new fetch. */
export const FAILURE_TTL_MS = 60_000;

/** The most failures remembered; the oldest is forgotten first. */
const MAX_FAILURES = 1_000;

/** Metadata-document fetches per client IP (IPv6: per /64) per window. */
export const FETCH_RATE_LIMIT = 20;
export const FETCH_RATE_WINDOW_MS = 15 * 60 * 1000;

/** The rate limiter's store name (a shared store, #67b, namespaces by it). */
export const FETCH_LIMITER_NAME = 'cimd-fetch';

const USER_AGENT = 'ynab-mcp (client-id-metadata-document)';

/** Why a document was refused. Logged, never sent. */
export type MetadataDocumentFailure =
  | 'url'
  | 'resolve'
  | 'address'
  | 'connect'
  | 'timeout'
  | 'status'
  | 'redirect'
  | 'encoding'
  | 'too-large'
  | 'json'
  | 'client-id'
  | 'auth-method'
  | 'metadata';

/** The one message every refusal carries (the library copies it into its debug-only `error_detail`). */
const FAILURE_MESSAGE = 'client_id metadata document refused';

export class MetadataDocumentError extends Error {
  constructor(
    readonly reason: MetadataDocumentFailure,
    /** For `metadata`: the value-free rule that failed (client-metadata.ts). Logged only. */
    readonly rule?: string
  ) {
    super(FAILURE_MESSAGE);
    this.name = 'MetadataDocumentError';
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * IPv4 ranges that are not public unicast (IANA special-purpose registry):
 * "this network" and unspecified, private (RFC 1918), CGNAT (RFC 6598),
 * loopback, link-local, IETF protocol assignments, the documentation and
 * benchmarking nets, the 6to4 relay anycast, multicast, and 240/4 (reserved,
 * with the broadcast address).
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * IPv6: only global unicast (2000::/3) is public. Inside it, these are not:
 * IETF protocol assignments (2001::/23, which holds Teredo), documentation
 * (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16, which embeds an IPv4
 * address). Everything outside 2000::/3 (unspecified, loopback, IPv4-
 * compatible, NAT64, discard, unique-local, link-local, site-local,
 * multicast) is refused by that rule; IPv4-mapped addresses are judged by
 * their IPv4 address.
 */
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const blockedV4 = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockedV4.addSubnet(net, prefix, 'ipv4');
const blockedV6 = new BlockList();
for (const [net, prefix] of BLOCKED_V6) blockedV6.addSubnet(net, prefix, 'ipv6');

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail included), or undefined. */
function ipv6Groups(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head = '', rest] = text.split('::') as [string, string | undefined];
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const left = parse(head);
  if (rest === undefined) return left.length === 8 ? left : undefined;
  const right = parse(rest);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Whether `address` (an IP literal) is anything but public unicast: this
 * server never connects to such an address for a metadata document. A value
 * that isn't an IP address, or carries an IPv6 zone (`%eth0`), counts as
 * special-use (fail closed).
 */
export function isSpecialUseAddress(address: string): boolean {
  if (address.includes('%')) return true;
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, 'ipv4');
  const groups = ipv6Groups(address);
  if (family !== 6 || groups === undefined) return true;
  // IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1): judged as the IPv4 address it is.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return blockedV4.check(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, 'ipv4');
  }
  if (((groups[0] ?? 0) & 0xe000) !== 0x2000) return true;
  return blockedV6.check(address, 'ipv6');
}

/** An address as a socket reports it, for comparison: an IPv4-mapped IPv6 address as its IPv4 form. */
function normalizeAddress(address: string): string {
  const groups = ipv6Groups(address);
  if (groups !== undefined && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return groups !== undefined ? groups.map((g) => g.toString(16)).join(':') : address;
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/** The request function the fetch uses (https.request's shape). */
export type MetadataRequest = (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

/**
 * What the fetch connects with. Production uses the defaults; tests inject a
 * resolver and a request function so nothing reaches the network.
 */
export interface MetadataTransport {
  /** Resolves a host name to every address it has (default: the system resolver, `all: true`). */
  resolve?: ((hostname: string) => Promise<readonly LookupAddress[]>) | undefined;
  /** Makes the request (default: `https.request`). */
  request?: MetadataRequest | undefined;
  /** The fetch deadline (default {@link FETCH_TIMEOUT_MS}). */
  timeoutMs?: number | undefined;
  /**
   * Tests only: which resolved addresses may be connected to (default: not
   * {@link isSpecialUseAddress}). Never set from configuration.
   */
  isAllowedAddress?: ((address: string) => boolean) | undefined;
}

/** A fetched document's bytes and its `Cache-Control` header. */
export interface FetchedDocument {
  body: Buffer;
  cacheControl: string | undefined;
}

const defaultResolve = (hostname: string): Promise<readonly LookupAddress[]> =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Resolves, or rejects with `timeout` when the signal fires first. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MetadataDocumentError('timeout'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new MetadataDocumentError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** The URL a metadata document may be fetched from, or a `url` failure. */
function documentUrl(raw: string): URL {
  const url = URL.parse(raw);
  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    raw.includes('#') ||
    // The default port only: a client_id URL names a web page, not a service on some port.
    url.port !== '' ||
    url.hostname === ''
  ) {
    throw new MetadataDocumentError('url');
  }
  return url;
}

/**
 * Fetch a metadata document under the guards in the file comment. Resolves
 * with the body, or rejects with a {@link MetadataDocumentError}.
 */
export async function fetchMetadataDocument(
  rawUrl: string,
  transport: MetadataTransport = {},
  callerSignal?: AbortSignal | null
): Promise<FetchedDocument> {
  const url = documentUrl(rawUrl);
  const timeout = AbortSignal.timeout(transport.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  const allowed = transport.isAllowedAddress ?? ((address: string) => !isSpecialUseAddress(address));

  // An IP-literal host is never looked up: it is checked as it is.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: readonly LookupAddress[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await withSignal((transport.resolve ?? defaultResolve)(host), signal);
    } catch (err) {
      throw err instanceof MetadataDocumentError ? err : new MetadataDocumentError('resolve');
    }
  }
  // Every address must be public, not just the first: a resolver's answer order is not ours to trust.
  if (addresses.length === 0) throw new MetadataDocumentError('resolve');
  if (!addresses.every((a) => typeof a.address === 'string' && allowed(a.address))) {
    throw new MetadataDocumentError('address');
  }
  const checked = addresses.map(({ address, family }) => ({ address, family }));
  const checkedPeers = new Set(checked.map((a) => normalizeAddress(a.address)));
  const first = checked[0] as LookupAddress;

  // The connection goes to the checked addresses only, whatever the name resolves to by then
  // (DNS rebinding). Asked for every address, the lookup answers the whole checked set, so the
  // connection can fall back from one that doesn't answer (an unreachable IPv6, say) to the next.
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) {
      (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(
        null,
        checked.map((a) => ({ ...a }))
      );
    } else {
      callback(null, first.address, first.family);
    }
  };

  const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
    hostname: host,
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    // No Accept-Encoding: the body must come as it is (a compressed one is refused, never inflated).
    // Host is the URL's own (the connection goes to an address, the request to the name).
    headers: { host: url.host, accept: 'application/json', 'user-agent': USER_AGENT },
    agent: false,
    lookup: pinnedLookup,
    // Try each checked address in turn (Happy Eyeballs), even if the process default is off:
    // that is what makes the lookup ask for, and use, the whole set.
    autoSelectFamily: true,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    signal,
  };

  return new Promise<FetchedDocument>((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | undefined;
    const fail = (reason: MetadataDocumentFailure): void => {
      if (settled) return;
      settled = true;
      req?.destroy();
      reject(new MetadataDocumentError(reason));
    };
    const onAbort = (): void => fail('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (doc: FetchedDocument): void => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      resolve(doc);
    };

    try {
      req = (transport.request ?? httpsRequest)(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          fail(status >= 300 && status < 400 ? 'redirect' : 'status');
          return;
        }
        const encoding = res.headers['content-encoding'];
        if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
          res.resume();
          fail('encoding');
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
          res.resume();
          fail('too-large');
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_DOCUMENT_BYTES) {
            fail('too-large');
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const cacheControl = res.headers['cache-control'];
          done({ body: Buffer.concat(chunks), cacheControl: typeof cacheControl === 'string' ? cacheControl : undefined });
        });
        res.on('error', () => fail(signal.aborted ? 'timeout' : 'connect'));
        res.on('aborted', () => fail(signal.aborted ? 'timeout' : 'connect'));
      });
    } catch {
      fail('connect');
      return;
    }
    req.on('error', () => fail(signal.aborted ? 'timeout' : 'connect'));
    // Defence in depth: the peer must be one of the addresses that were checked.
    req.on('socket', (socket) => {
      const check = (): void => {
        const remote = socket.remoteAddress;
        if (remote === undefined || !checkedPeers.has(normalizeAddress(remote))) fail('address');
      };
      if (socket.remoteAddress !== undefined && !socket.connecting) check();
      else socket.once('connect', check);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * Parse a fetched document and hold it to `/register`'s rules. Returns what
 * the library is handed: the fields a registration keeps, normalized, with
 * `client_id` (the URL, verbatim, so the library's own equality check holds)
 * and `token_endpoint_auth_method: none`.
 */
export function normalizeMetadataDocument(
  clientId: string,
  body: Buffer,
  policy: ClientMetadataPolicy
): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString('utf8'));
  } catch {
    throw new MetadataDocumentError('json');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new MetadataDocumentError('json');
  const fields = doc as Record<string, unknown>;
  if (fields['client_id'] !== clientId) throw new MetadataDocumentError('client-id');
  // A metadata-document client is public: no shared secret, no other authentication method.
  if ('client_secret' in fields || 'client_secret_expires_at' in fields) throw new MetadataDocumentError('auth-method');
  const method = fields['token_endpoint_auth_method'];
  if (method !== undefined && method !== 'none') throw new MetadataDocumentError('auth-method');
  const supported = fields['token_endpoint_auth_methods_supported'];
  if (supported !== undefined && !(Array.isArray(supported) && supported.includes('none'))) {
    throw new MetadataDocumentError('auth-method');
  }
  // client_id is the server's to set for a registration; here it is the URL, checked above.
  const { client_id: _id, ...rest } = fields;
  const result = registrableMetadata(rest, policy);
  if (!result.ok) throw new MetadataDocumentError('metadata', result.error.error_description);
  return { ...result.metadata, client_id: clientId, token_endpoint_auth_method: 'none' };
}

/** A document's cache lifetime in seconds: its `max-age`, within {@link CACHE_DURATION_SEC}. */
export function cacheDurationSec(cacheControl: string | undefined): number {
  const match = cacheControl === undefined ? null : /(?:^|,)\s*max-age\s*=\s*"?(\d{1,10})"?\s*(?:,|$)/i.exec(cacheControl);
  const seconds = match ? Number(match[1]) : CACHE_DURATION_SEC.min;
  return Math.min(CACHE_DURATION_SEC.max, Math.max(CACHE_DURATION_SEC.min, seconds));
}

// ---------------------------------------------------------------------------
// The library's hooks
// ---------------------------------------------------------------------------

export { isMetadataDocumentClientId } from './client-id-url.js';

/** Who a lookup is for, as the `cimd-context` stage recorded it. */
interface Requester {
  /** The client-IP rate-limit key (rate-limit-key.ts clientIp). */
  readonly key: string;
  /** URLs this request has already been charged a fetch for. */
  readonly charged: Set<string>;
  /** Set once this request is over its budget: later lookups in it are refused too. */
  limited: boolean;
}

export interface ClientIdMetadataOptions {
  policy: ClientMetadataPolicy;
  /** How the client IP is read (TRUST_CF_CONNECTING_IP), as every AS limiter reads it. */
  keyOptions: ClientKeyOptions;
  /** A shared limiter store (#67b); the in-memory store when absent. */
  limiterStore?: LimiterStoreFactory | undefined;
  transport?: MetadataTransport | undefined;
  /** Epoch ms; tests only. */
  now?: (() => number) | undefined;
}

/** The library's `fetch` signature (configuration.fetch). */
export type LibraryFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<globalThis.Response>;

export interface ClientIdMetadataDocuments {
  /** `features.clientIdMetadataDocument`, enabled. */
  readonly feature: {
    enabled: true;
    ack: string;
    allowFetch: (ctx: unknown, clientId: string) => Promise<boolean>;
    cacheDuration: { min: number; max: number };
  };
  /** `configuration.fetch`: the guarded fetch, with the document normalized. */
  readonly fetch: LibraryFetch;
  /** The `cimd-context` stage: records the requester for the fetch budget. */
  readonly requesterContext: RequestHandler;
}

/** Build the hooks provider.ts and as-router.ts wire in. */
export function createClientIdMetadataDocuments(options: ClientIdMetadataOptions): ClientIdMetadataDocuments {
  const now = options.now ?? Date.now;
  const requesters = new AsyncLocalStorage<Requester>();
  const failures = new Map<string, number>();
  const store: Store = options.limiterStore?.(FETCH_LIMITER_NAME) ?? new MemoryStore();
  // express-rate-limit calls init itself; the store is used directly here, so it is called once here.
  void store.init?.({ windowMs: FETCH_RATE_WINDOW_MS } as RateLimitOptions);

  const failedRecently = (url: string): boolean => {
    const until = failures.get(url);
    if (until === undefined) return false;
    if (until > now()) return true;
    failures.delete(url);
    return false;
  };
  const remember = (url: string, err: MetadataDocumentError): void => {
    failures.delete(url);
    if (failures.size >= MAX_FAILURES) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
    failures.set(url, now() + FAILURE_TTL_MS);
    const host = URL.parse(url)?.host ?? '(unparsable)';
    console.warn(
      `[OAuth] Client ID metadata document refused (${err.reason}${err.rule !== undefined ? `: ${err.rule}` : ''}) for host ${host}`
    );
  };

  const allowFetch = async (_ctx: unknown, clientId: string): Promise<boolean> => {
    if (failedRecently(clientId)) return false;
    const requester = requesters.getStore();
    if (requester?.limited === true) return false;
    // The second lookup of one request (authorize-validation's, then the library's) is not charged again.
    if (requester?.charged.has(clientId) === true) return true;
    const { totalHits } = await store.increment(`cimd:${requester?.key ?? 'unknown'}`);
    requester?.charged.add(clientId);
    if (totalHits > FETCH_RATE_LIMIT) {
      if (requester) requester.limited = true;
      return false;
    }
    return true;
  };

  const fetch: LibraryFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try {
      const fetched = await fetchMetadataDocument(url, options.transport, init?.signal);
      const document = normalizeMetadataDocument(url, fetched.body, options.policy);
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${cacheDurationSec(fetched.cacheControl)}` },
      });
    } catch (err) {
      const failure = err instanceof MetadataDocumentError ? err : new MetadataDocumentError('connect');
      remember(url, failure);
      throw new MetadataDocumentError(failure.reason);
    }
  };

  const requesterContext: RequestHandler = (req: Request, _res: ExpressResponse, next: NextFunction): void => {
    requesters.run({ key: clientIp(req, options.keyOptions), charged: new Set(), limited: false }, next);
  };

  return {
    feature: { enabled: true, ack: CIMD_ACK, allowFetch, cacheDuration: { ...CACHE_DURATION_SEC } },
    fetch,
    requesterContext,
  };
}

/**
 * `configuration.fetch` while metadata documents are off: the library never
 * fetches anything. (It has no other fetch here: `sector_identifier_uri` is
 * refused, and `jwks_uri` is only read for client assertions, which
 * `client_secret_post` and `none` never use.)
 */
export const refuseFetch: LibraryFetch = () => Promise.reject(new MetadataDocumentError('url'));
