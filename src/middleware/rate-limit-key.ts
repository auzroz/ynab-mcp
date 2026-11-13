/**
 * Rate-limit keys (#59).
 *
 *  - An authenticated request is keyed by user: `user:<id>`.
 *  - An unauthenticated one is keyed by (client_id, IP), never client_id alone:
 *    a client_id is public, so keying by it alone would let anyone spend a
 *    client's budget. Without a client_id the key is the IP.
 *  - The IP is Express's `req.ip`, which honours TRUST_PROXY (the hop count),
 *    unless `trustCfConnectingIp` is on and the request carries a valid
 *    `CF-Connecting-IP`. That header is read only then; it is separate from
 *    TRUST_PROXY because a hop count says nothing about whether the origin can
 *    be reached without passing through Cloudflare.
 *  - IPv6 addresses collapse to their /64 (and an IPv4-mapped IPv6 address to
 *    its IPv4), so one host cannot spread across its own address block.
 */

import { isIP } from 'node:net';
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

export interface ClientKeyOptions {
  /** `TRUST_CF_CONNECTING_IP`. */
  trustCfConnectingIp: boolean;
}

/** Who a limited request is from, as far as the endpoint knows. */
export interface KeySubject {
  /** A verified user id (an authenticated endpoint). */
  userId?: string | undefined;
  /** The OAuth client_id the request names (an unauthenticated endpoint). */
  clientId?: string | undefined;
}

/** IPv6 prefix length a client is keyed by. */
export const IPV6_PREFIX = 64;

/** Longest client_id kept in a key; longer values are cut (the key is not an identity, only a bucket). */
const MAX_CLIENT_ID_KEY = 200;

/** The client address to key on: collapsed IPv6, or `unknown` when the socket has none. */
export function clientIp(req: Request, options: ClientKeyOptions): string {
  let ip: string | undefined;
  if (options.trustCfConnectingIp) {
    const cf = req.header('cf-connecting-ip')?.trim();
    // A malformed value is ignored, not trusted: fall back to the socket's view.
    if (cf && isIP(cf) !== 0) ip = cf;
  }
  ip ??= req.ip ?? req.socket?.remoteAddress;
  if (!ip || isIP(ip) === 0) return 'unknown';
  return ipKeyGenerator(ip, IPV6_PREFIX);
}

/** The rate-limit key for `req`. */
export function clientKey(req: Request, options: ClientKeyOptions, subject: KeySubject = {}): string {
  if (subject.userId) return `user:${subject.userId}`;
  const ip = clientIp(req, options);
  const clientId = subject.clientId?.slice(0, MAX_CLIENT_ID_KEY);
  return clientId ? `client:${clientId}|ip:${ip}` : `ip:${ip}`;
}

/**
 * The client_id an OAuth request names: the HTTP Basic user (RFC 6749 2.3.1),
 * else the `client_id` body field, else the query's (`/authorize`). Strings
 * only; anything else counts as no client_id.
 */
export function requestClientId(req: Request): string | undefined {
  const auth = req.header('authorization');
  if (auth && /^basic /i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const user = decoded.split(':', 1)[0];
      if (user) return safeDecode(user);
    } catch {
      // Not a usable Basic header: fall through to the fields.
    }
  }
  const body = req.body as { client_id?: unknown } | undefined;
  if (typeof body?.client_id === 'string' && body.client_id) return body.client_id;
  const q = req.query['client_id'];
  if (typeof q === 'string' && q) return q;
  return undefined;
}

/** RFC 6749 form-encodes the Basic user; decode it, or keep it raw when it isn't valid. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * The /register keys for a registration body: one per distinct redirect URI
 * host, so adding a second host does not dodge the first's budget.
 *
 *  - A public http(s) host keys by the host alone: `host:<hostname>` (hosted
 *    MCP clients register from one small IP range but share a redirect host).
 *  - A loopback host (localhost, 127.x, ::1) is shared by every native client
 *    on every machine, so it keys by (host, IP): `loopback|ip:<ip>`.
 *  - A private-use scheme (`com.example.app:/cb`) keys by (scheme, IP).
 *  - A body without a usable redirect URI keys by IP: `no-redirect|ip:<ip>`.
 *
 * At most MAX_REDIRECT_HOSTS distinct keys are returned (the body is
 * untrusted, and the DCR validator limits the count anyway).
 */
export const MAX_REDIRECT_HOSTS = 10;

export function redirectHostKeys(body: unknown, ip: string): string[] {
  const uris = (body as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  const keys = new Set<string>();
  if (Array.isArray(uris)) {
    for (const uri of uris.slice(0, MAX_REDIRECT_HOSTS * 2)) {
      if (typeof uri !== 'string') continue;
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        continue;
      }
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const host = url.hostname.toLowerCase();
        keys.add(isLoopbackHost(host) ? `loopback|ip:${ip}` : `host:${host}`);
      } else {
        keys.add(`scheme:${url.protocol}|ip:${ip}`);
      }
      if (keys.size >= MAX_REDIRECT_HOSTS) break;
    }
  }
  return keys.size > 0 ? [...keys] : [`no-redirect|ip:${ip}`];
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
