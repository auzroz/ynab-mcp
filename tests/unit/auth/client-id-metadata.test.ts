/**
 * #46: Client ID Metadata Documents, the guarded fetch and the document rules
 * (src/auth/client-id-metadata.ts), on their own. The HTTP flow through the
 * authorization server is in tests/unit/http-oauth-cimd.test.ts.
 *
 * Nothing here reaches the network. The fetch's resolver and request function
 * are injected: the transport tests serve documents from a plain-http server
 * on 127.0.0.1 and allow that one address; the address tests keep the real
 * address policy, and their request function must never be called.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:https';
import type { Request } from 'express';
import {
  CACHE_DURATION_SEC,
  CIMD_ACK,
  FAILURE_TTL_MS,
  FETCH_RATE_LIMIT,
  MAX_DOCUMENT_BYTES,
  MetadataDocumentError,
  cacheDurationSec,
  createClientIdMetadataDocuments,
  fetchMetadataDocument,
  isMetadataDocumentClientId,
  isSpecialUseAddress,
  normalizeMetadataDocument,
  type MetadataDocumentFailure,
  type MetadataTransport,
} from '../../../src/auth/client-id-metadata.js';

const CLIENT_ID = 'https://client.example/oauth/client.json';
const POLICY = { privateUseSchemes: ['com.example.app'] };

/** The reason a promise was refused with. */
async function reasonOf(promise: Promise<unknown>): Promise<MetadataDocumentFailure> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MetadataDocumentError);
    expect((err as Error).message).toBe('client_id metadata document refused');
    return (err as MetadataDocumentError).reason;
  }
  throw new Error('expected a refusal');
}

function reasonOfSync(fn: () => unknown): MetadataDocumentFailure {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MetadataDocumentError);
    return (err as MetadataDocumentError).reason;
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------
// A local document server
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(handler: Handler): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

/** Connects to the local server, plain http, as if `client.example` resolved to 127.0.0.1. */
function localTransport(port: number, overrides: MetadataTransport = {}): MetadataTransport {
  return {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    request: (options, callback) => httpRequest({ ...options, port }, callback),
    isAllowedAddress: (address) => address === '127.0.0.1',
    ...overrides,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

describe('isSpecialUseAddress', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'this network'],
    ['10.1.2.3', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12, top'],
    ['192.168.1.1', 'private 192.168/16'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT, top'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback, top'],
    ['169.254.169.254', 'link-local (cloud metadata)'],
    ['192.0.0.8', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast (SSDP)'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'IPv6 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback, dotted'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex (as WHATWG URL writes it)'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped link-local'],
    ['0:0:0:0:0:ffff:c0a8:0101', 'IPv4-mapped private, long form'],
    ['::127.0.0.1', 'IPv4-compatible (deprecated)'],
    ['64:ff9b::7f00:1', 'NAT64'],
    ['100::1', 'discard'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local with a zone'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (3fff::/20)'],
    ['2002:7f00:1::1', '6to4 (embeds 127.0.0.1)'],
    ['not-an-address', 'not an IP'],
    ['', 'empty'],
  ])('refuses %s (%s)', (address) => {
    expect(isSpecialUseAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '11.0.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
  ])('allows the public address %s', (address) => {
    expect(isSpecialUseAddress(address)).toBe(false);
  });
});

describe('isMetadataDocumentClientId (#64a marker)', () => {
  it('is true for https URLs only', () => {
    expect(isMetadataDocumentClientId(CLIENT_ID)).toBe(true);
    expect(isMetadataDocumentClientId('HTTPS://client.example/c')).toBe(true);
    expect(isMetadataDocumentClientId('3f2a6c1e-0b8e-4b7a-9d55-3b1f0c2d4e5f')).toBe(false);
    expect(isMetadataDocumentClientId('V1StGXR8_Z5jdHi6B-myT')).toBe(false);
    expect(isMetadataDocumentClientId('http://client.example/c')).toBe(false);
    expect(isMetadataDocumentClientId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

describe('fetchMetadataDocument: the URL', () => {
  const never = vi.fn();
  const transport: MetadataTransport = { resolve: never, request: never };

  it.each([
    ['http://client.example/c.json', 'not https'],
    ['https://user:pw@client.example/c.json', 'userinfo'],
    ['https://client.example:8443/c.json', 'a port other than 443'],
    ['https://client.example/c.json#frag', 'a fragment'],
    ['not a url', 'not a URL'],
  ])('refuses %s (%s) without resolving', async (url) => {
    expect(await reasonOf(fetchMetadataDocument(url, transport))).toBe('url');
    expect(never).not.toHaveBeenCalled();
  });
});

describe('fetchMetadataDocument: addresses (real policy, no connection)', () => {
  const blocked = ['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.1.1', '224.0.0.251', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::'];

  it.each(blocked)('refuses a host that resolves to %s, and never connects', async (address) => {
    const request = vi.fn();
    const resolve = vi.fn(async (): Promise<LookupAddress[]> => [{ address, family: address.includes(':') ? 6 : 4 }]);
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, { resolve, request }))).toBe('address');
    expect(resolve).toHaveBeenCalledWith('client.example');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a host with any special-use address, even after a public one', async () => {
    const request = vi.fn();
    const resolve = async (): Promise<LookupAddress[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, { resolve, request }))).toBe('address');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'https://127.0.0.1/client.json',
    'https://10.1.1.1/client.json',
    'https://[::1]/client.json',
    // WHATWG URL rewrites this to [::ffff:7f00:1]: the hex form must be caught too.
    'https://[::ffff:127.0.0.1]/client.json',
    'https://[fe80::1]/client.json',
  ])('refuses the IP-literal URL %s without a lookup', async (url) => {
    const resolve = vi.fn();
    const request = vi.fn();
    expect(await reasonOf(fetchMetadataDocument(url, { resolve, request }))).toBe('address');
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to nothing, or fails to resolve', async () => {
    const request = vi.fn();
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, { resolve: async () => [], request }))).toBe('resolve');
    const failing = async (): Promise<LookupAddress[]> => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND client.example'), { code: 'ENOTFOUND' });
    };
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, { resolve: failing, request }))).toBe('resolve');
    expect(request).not.toHaveBeenCalled();
  });

  it('DNS rebinding: resolves once, and connects only to the addresses it checked', async () => {
    // A rebinding resolver: public on the first query, private on every later one.
    let queries = 0;
    const resolve = vi.fn(async (): Promise<LookupAddress[]> => {
      queries++;
      return queries === 1
        ? [
            { address: '93.184.216.34', family: 4 },
            { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
          ]
        : [{ address: '127.0.0.1', family: 4 }];
    });
    let seen: RequestOptions | undefined;
    const request = vi.fn((options: RequestOptions) => {
      seen = options;
      // Stand in for the connection: fail it, as an unreachable host would.
      const req = httpRequest({ host: '127.0.0.1', port: 9, lookup: undefined });
      queueMicrotask(() => req.destroy(new Error('stand-in')));
      return req;
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, { resolve, request }))).toBe('connect');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(seen?.hostname).toBe('client.example');
    expect(seen?.servername).toBe('client.example');
    expect(seen?.agent).toBe(false);
    // Each checked address is tried in turn, whatever the process-wide default.
    expect((seen as { autoSelectFamily?: boolean } | undefined)?.autoSelectFamily).toBe(true);
    // Whatever the name resolves to now, the connection's lookup answers the checked addresses.
    const lookup = seen?.lookup as NonNullable<RequestOptions['lookup']>;
    const one = await new Promise<unknown[]>((res) => lookup('client.example', {}, (...args: unknown[]) => res(args)));
    expect(one).toEqual([null, '93.184.216.34', 4]);
    const all = await new Promise<unknown[]>((res) => lookup('client.example', { all: true }, (...args: unknown[]) => res(args)));
    expect(all).toEqual([
      null,
      [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('refuses a connection whose peer is not the checked address', async () => {
    const { port, hits } = await serve(json({ client_id: CLIENT_ID }));
    // The resolver answers a public address, but the connection lands on 127.0.0.1.
    const transport: MetadataTransport = {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (options, callback) => httpRequest({ ...options, lookup: undefined, hostname: '127.0.0.1', port }, callback),
    };
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, transport))).toBe('address');
    expect(hits()).toBe(0);
  });

  it('refuses a peer outside the checked set, even one the address policy would allow', async () => {
    const { port, hits } = await serve(json({ client_id: CLIENT_ID }));
    // Several checked addresses; the connection lands on 127.0.0.1, which this policy allows but nobody checked.
    const transport: MetadataTransport = {
      isAllowedAddress: () => true,
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
      request: (options, callback) => httpRequest({ ...options, lookup: undefined, hostname: '127.0.0.1', port }, callback),
    };
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, transport))).toBe('address');
    expect(hits()).toBe(0);
  });
});

describe('fetchMetadataDocument: the response (local server)', () => {
  it('returns a document and its Cache-Control', async () => {
    const seen: IncomingMessage[] = [];
    const { port } = await serve((req, res) => {
      seen.push(req);
      json({ client_id: CLIENT_ID }, { 'cache-control': 'max-age=600' })(req, res);
    });
    const doc = await fetchMetadataDocument(CLIENT_ID, localTransport(port));
    expect(JSON.parse(doc.body.toString())).toEqual({ client_id: CLIENT_ID });
    expect(doc.cacheControl).toBe('max-age=600');
    // The original host as Host, the URL's path, GET, no compression asked for.
    expect(seen[0]?.headers.host).toBe('client.example');
    expect(seen[0]?.url).toBe('/oauth/client.json');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers['accept-encoding']).toBeUndefined();
  });

  it('falls back from a checked address that refuses the connection to the next checked one', async () => {
    const { port, hits } = await serve(json({ client_id: CLIENT_ID }));
    // The server listens on 127.0.0.1 only, so ::1 refuses (or is unreachable, without IPv6): the
    // connection must move on to 127.0.0.1 within the one deadline, not fail on the first address.
    const transport = localTransport(port, {
      resolve: async () => [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ],
      isAllowedAddress: (address) => address === '::1' || address === '127.0.0.1',
    });
    const doc = await fetchMetadataDocument(CLIENT_ID, transport);
    expect(JSON.parse(doc.body.toString())).toEqual({ client_id: CLIENT_ID });
    expect(hits()).toBe(1);
  });

  it.each([301, 302, 303, 307, 308])('refuses a %i redirect and does not follow it', async (status) => {
    const { port, hits } = await serve((_req, res) => {
      res.writeHead(status, { location: 'https://client.example/elsewhere.json' });
      res.end();
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port)))).toBe('redirect');
    expect(hits()).toBe(1);
  });

  it.each([204, 404, 500])('refuses status %i', async (status) => {
    const { port } = await serve((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port)))).toBe('status');
  });

  it('refuses a declared Content-Length over the cap', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': String(MAX_DOCUMENT_BYTES + 1) });
      res.end('x'.repeat(MAX_DOCUMENT_BYTES + 1));
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port)))).toBe('too-large');
  });

  it('counts a streamed body without Content-Length, and stops past the cap', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Chunked: no length is declared, so the cap is counted as it streams.
      for (let i = 0; i < 20; i++) res.write('x'.repeat(1024));
      res.end();
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port)))).toBe('too-large');
  });

  it('accepts a body of exactly the cap', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(MAX_DOCUMENT_BYTES));
    });
    expect((await fetchMetadataDocument(CLIENT_ID, localTransport(port))).body.length).toBe(MAX_DOCUMENT_BYTES);
  });

  it('refuses a compressed body', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('compressed');
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port)))).toBe('encoding');
  });

  it('times out a server that never answers', async () => {
    const { port } = await serve(() => undefined);
    const started = Date.now();
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port, { timeoutMs: 150 })))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('times out a body that drips in', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200);
      res.write('{');
      const timer = setInterval(() => res.write(' '), 20);
      res.on('close', () => clearInterval(timer));
    });
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port, { timeoutMs: 200 })))).toBe('timeout');
  });

  it('times out a resolver that never answers', async () => {
    const request = vi.fn();
    const resolve = (): Promise<LookupAddress[]> => new Promise(() => undefined);
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, { resolve, request, timeoutMs: 100 }))).toBe('timeout');
    expect(request).not.toHaveBeenCalled();
  });

  it("honours the caller's signal (the library's own 2.5 s one)", async () => {
    const { port } = await serve(() => undefined);
    const caller = AbortSignal.timeout(100);
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port), caller))).toBe('timeout');
  });

  it('refuses a refused connection', async () => {
    const { port } = await serve(() => undefined);
    await Promise.all(servers.splice(0).map((s) => s.close()));
    expect(await reasonOf(fetchMetadataDocument(CLIENT_ID, localTransport(port)))).toBe('connect');
  });
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe('normalizeMetadataDocument', () => {
  const doc = (fields: Record<string, unknown>): Buffer =>
    Buffer.from(JSON.stringify({ client_id: CLIENT_ID, redirect_uris: ['https://client.example/cb'], ...fields }));

  it('keeps what a registration keeps, public, with client_id verbatim', () => {
    const out = normalizeMetadataDocument(
      CLIENT_ID,
      doc({
        client_name: 'Example Client',
        scope: 'read-only read-write',
        logo_uri: 'https://client.example/logo.png',
        jwks_uri: 'https://client.example/jwks',
        contacts: ['a@client.example'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      }),
      POLICY
    );
    expect(out).toEqual({
      client_id: CLIENT_ID,
      redirect_uris: ['https://client.example/cb'],
      client_name: 'Example Client',
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('makes a loopback-only client native, as a registration would', () => {
    const out = normalizeMetadataDocument(CLIENT_ID, doc({ redirect_uris: ['http://127.0.0.1:33418/cb'] }), POLICY);
    expect(out['application_type']).toBe('native');
  });

  it('accepts an allowed private-use scheme', () => {
    const out = normalizeMetadataDocument(CLIENT_ID, doc({ redirect_uris: ['com.example.app:/cb'] }), POLICY);
    expect(out['redirect_uris']).toEqual(['com.example.app:/cb']);
  });

  it('refuses a document whose client_id is not the URL', () => {
    for (const other of ['https://attacker.example/client.json', `${CLIENT_ID}/`, CLIENT_ID.toUpperCase(), undefined]) {
      expect(reasonOfSync(() => normalizeMetadataDocument(CLIENT_ID, doc({ client_id: other }), POLICY))).toBe('client-id');
    }
  });

  it.each([
    [['http://client.example/cb'], /redirect_uris\[0\]: http is allowed only for localhost/],
    [['https://client.example/cb#x'], /fragment/],
    [['javascript:alert(1)'], /scheme is not allowed/],
    [['com.other.app:/cb'], /MCP_DCR_PRIVATE_USE_SCHEMES/],
    [[], /at least one/],
    [['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4', 'https://a.example/5', 'https://a.example/6'], /at most 5/],
  ])('refuses the redirect URIs %j as /register does', (uris, rule) => {
    try {
      normalizeMetadataDocument(CLIENT_ID, doc({ redirect_uris: uris }), POLICY);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as MetadataDocumentError).reason).toBe('metadata');
      expect((err as MetadataDocumentError).rule).toMatch(rule);
      // The public message never carries the rule or a value.
      expect((err as Error).message).toBe('client_id metadata document refused');
    }
  });

  it('refuses sector_identifier_uri and a bad client_name, as /register does', () => {
    expect(reasonOfSync(() => normalizeMetadataDocument(CLIENT_ID, doc({ sector_identifier_uri: 'https://x.example' }), POLICY))).toBe('metadata');
    expect(reasonOfSync(() => normalizeMetadataDocument(CLIENT_ID, doc({ client_name: 'a‮b' }), POLICY))).toBe('metadata');
  });

  it.each([
    [{ client_secret: 'shh' }],
    [{ client_secret_expires_at: 0 }],
    [{ token_endpoint_auth_method: 'client_secret_post' }],
    [{ token_endpoint_auth_method: 'client_secret_basic' }],
    [{ token_endpoint_auth_method: 'private_key_jwt' }],
    [{ token_endpoint_auth_methods_supported: ['client_secret_basic'] }],
    [{ token_endpoint_auth_methods_supported: 'none' }],
  ])('refuses a client that is not public: %j', (fields) => {
    expect(reasonOfSync(() => normalizeMetadataDocument(CLIENT_ID, doc(fields), POLICY))).toBe('auth-method');
  });

  it.each(['not json', '[1,2]', 'null', '"string"'])('refuses the body %s', (body) => {
    expect(reasonOfSync(() => normalizeMetadataDocument(CLIENT_ID, Buffer.from(body), POLICY))).toBe('json');
  });
});

describe('cacheDurationSec', () => {
  it.each([
    [undefined, CACHE_DURATION_SEC.min],
    ['no-store', CACHE_DURATION_SEC.min],
    ['max-age=0', CACHE_DURATION_SEC.min],
    ['max-age=60', CACHE_DURATION_SEC.min],
    ['max-age=3600', 3600],
    ['public, max-age=600', 600],
    ['max-age=600, must-revalidate', 600],
    ['max-age=99999999', CACHE_DURATION_SEC.max],
    ['s-maxage=3600', CACHE_DURATION_SEC.min],
  ])('%s is %i seconds', (header, seconds) => {
    expect(cacheDurationSec(header)).toBe(seconds);
  });

  it('is bounded by 5 minutes and 24 hours', () => {
    expect(CACHE_DURATION_SEC).toEqual({ min: 300, max: 86_400 });
  });
});

// ---------------------------------------------------------------------------
// The library's hooks
// ---------------------------------------------------------------------------

describe('createClientIdMetadataDocuments', () => {
  const keyOptions = { trustCfConnectingIp: false };
  const fakeReq = (ip: string): Request => ({ ip, header: () => undefined, socket: {} }) as unknown as Request;
  /** Run `fn` as the cimd-context stage would for a request from `ip`. */
  const asRequestFrom = <T>(hooks: ReturnType<typeof createClientIdMetadataDocuments>, ip: string, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      hooks.requesterContext(fakeReq(ip), {} as never, () => {
        fn().then(resolve, reject);
      });
    });

  it('acknowledges the draft the library implements', () => {
    const hooks = createClientIdMetadataDocuments({ policy: POLICY, keyOptions });
    expect(hooks.feature).toMatchObject({ enabled: true, ack: CIMD_ACK, cacheDuration: { min: 300, max: 86_400 } });
    expect(CIMD_ACK).toBe('draft-03');
  });

  it('hands the library the normalized document with a bounded max-age', async () => {
    const { port } = await serve(
      json(
        { client_id: CLIENT_ID, redirect_uris: ['https://client.example/cb'], scope: 'read-write', logo_uri: 'https://x/l.png' },
        { 'cache-control': 'max-age=999999999' }
      )
    );
    const hooks = createClientIdMetadataDocuments({ policy: POLICY, keyOptions, transport: localTransport(port) });
    const res = await hooks.fetch(CLIENT_ID, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(`max-age=${CACHE_DURATION_SEC.max}`);
    expect(await res.json()).toEqual({
      client_id: CLIENT_ID,
      redirect_uris: ['https://client.example/cb'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('caches a failure briefly: no new fetch until it expires', async () => {
    let now = 1_000_000;
    const { port, hits } = await serve(json({ client_id: 'https://someone.else/c.json', redirect_uris: ['https://c.example/cb'] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hooks = createClientIdMetadataDocuments({ policy: POLICY, keyOptions, transport: localTransport(port), now: () => now });
    expect(await hooks.feature.allowFetch(undefined, CLIENT_ID)).toBe(true);
    expect(await reasonOf(hooks.fetch(CLIENT_ID, {}))).toBe('client-id');
    expect(hits()).toBe(1);
    // Logged once, with the reason and the host only.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      '[OAuth] Client ID metadata document refused (client-id) for host client.example'
    );
    expect(await hooks.feature.allowFetch(undefined, CLIENT_ID)).toBe(false);
    now += FAILURE_TTL_MS - 1;
    expect(await hooks.feature.allowFetch(undefined, CLIENT_ID)).toBe(false);
    now += 2;
    expect(await hooks.feature.allowFetch(undefined, CLIENT_ID)).toBe(true);
  });

  it('charges fetches to the requesting IP, and refuses past the budget without caching a failure', async () => {
    const hooks = createClientIdMetadataDocuments({ policy: POLICY, keyOptions });
    const url = (i: number): string => `https://client${i}.example/c.json`;
    for (let i = 0; i < FETCH_RATE_LIMIT; i++) {
      expect(await asRequestFrom(hooks, '198.51.100.7', () => hooks.feature.allowFetch(undefined, url(i)))).toBe(true);
    }
    expect(await asRequestFrom(hooks, '198.51.100.7', () => hooks.feature.allowFetch(undefined, url(99)))).toBe(false);
    // Another address has its own budget, and the URL refused above is not poisoned for it.
    expect(await asRequestFrom(hooks, '203.0.113.9', () => hooks.feature.allowFetch(undefined, url(99)))).toBe(true);
  });

  it('charges one request once for the same URL (authorize-validation, then the library)', async () => {
    const hooks = createClientIdMetadataDocuments({ policy: POLICY, keyOptions });
    await asRequestFrom(hooks, '198.51.100.8', async () => {
      for (let i = 0; i < FETCH_RATE_LIMIT + 5; i++) expect(await hooks.feature.allowFetch(undefined, CLIENT_ID)).toBe(true);
    });
  });

  it('keys IPv6 requesters by /64', async () => {
    const hooks = createClientIdMetadataDocuments({ policy: POLICY, keyOptions });
    for (let i = 0; i < FETCH_RATE_LIMIT; i++) {
      const ip = `2001:4860:1:2::${(i + 1).toString(16)}`;
      expect(await asRequestFrom(hooks, ip, () => hooks.feature.allowFetch(undefined, `https://c${i}.example/c`))).toBe(true);
    }
    expect(await asRequestFrom(hooks, '2001:4860:1:2::ffff', () => hooks.feature.allowFetch(undefined, 'https://x.example/c'))).toBe(false);
  });
});
