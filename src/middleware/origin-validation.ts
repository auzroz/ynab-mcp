/**
 * Host and Origin validation for the HTTP transport (DNS-rebinding and
 * cross-site request protection).
 *
 * MCP 2025-06-18 (Streamable HTTP, "Security Warning") requires servers to
 * validate the `Origin` header on every incoming connection and to answer an
 * invalid one with 403; servers running locally must also guard against DNS
 * rebinding. We do both here, in one place.
 *
 * Why this replaces the SDK transport's `enableDnsRebindingProtection` /
 * `allowedHosts` / `allowedOrigins`: the transport only sees the `/mcp` routes,
 * compares the Host header as an exact, case-sensitive string (no IPv6
 * canonicalisation, no default-port handling) and only exists after a session is
 * created, so an unauthenticated `initialize` is checked late. This middleware
 * runs first, on the whole app, from the same HttpConfig lists, and the
 * transport's own check is left off so there is exactly one source of truth.
 *
 * Rules
 *  - Host: required, must be in the allowed hosts (case-insensitive; IPv6
 *    literals canonicalised; an entry without a port also matches the scheme's
 *    default port 80/443) else 403.
 *  - Origin: absent is allowed (non-browser clients). When present it must match
 *    an allowed origin exactly on scheme + host + port (host case-insensitive,
 *    default ports dropped) else 403. The opaque origin `null` is rejected.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Canonical `hostname[:port]` (lowercase, IPv6 in brackets, no default port), or null if malformed. */
export function normalizeHost(value: string | undefined): string | null {
  if (value === undefined) return null;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(`http://${m[1]}${m[2] ? `:${m[2]}` : ''}`);
  } catch {
    return null;
  }
  // A trailing dot (absolute FQDN) names the same host.
  const hostname = url.hostname.replace(/\.$/, '');
  if (hostname === '') return null;
  // URL drops :80; :443 is dropped below, so both default ports compare equal to "no port".
  const port = m[2] && m[2] !== '80' && m[2] !== '443' ? String(Number(m[2])) : '';
  return port ? `${hostname}:${port}` : hostname;
}

/** Canonical `scheme://host[:port]` of an Origin header value, or null if it is not a plain http(s) origin. */
export function normalizeOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  return url.origin.toLowerCase().replace(/\.(?=(:\d+)?$)/, '');
}

function forbidden(res: Response, message: string): void {
  res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * Build the Host-header check. Throws on a malformed allow-list entry so a typo
 * fails at startup instead of silently locking everyone out.
 */
export function hostValidation(allowedHosts: readonly string[], options: { skipPaths?: readonly string[] } = {}): RequestHandler {
  const allowed = new Set<string>();
  for (const entry of allowedHosts) {
    const n = normalizeHost(entry);
    if (n === null) throw new Error('Invalid ALLOWED_HOSTS entry: expected host or host:port (no scheme or path).');
    allowed.add(n);
  }
  const skip = new Set(options.skipPaths ?? []);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip.has(req.path)) {
      next();
      return;
    }
    const host = normalizeHost(req.headers.host);
    if (host === null || !allowed.has(host)) {
      forbidden(res, 'Forbidden: invalid Host header');
      return;
    }
    next();
  };
}

/**
 * Origins to allow when ALLOWED_ORIGINS/PUBLIC_URL gave none: https for every
 * allowed host, plus http for loopback hosts.
 */
export function deriveOriginsFromHosts(allowedHosts: readonly string[]): string[] {
  const origins: string[] = [];
  for (const entry of allowedHosts) {
    const n = normalizeHost(entry);
    if (n === null) continue;
    const hostname = n.replace(/:\d+$/, '');
    origins.push(`https://${n}`);
    if (LOOPBACK_HOSTNAMES.has(hostname)) origins.push(`http://${n}`);
  }
  return origins;
}

/** Build the Origin-header check (see module docs). Throws on a malformed entry. */
export function originValidation(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set<string>();
  for (const entry of allowedOrigins) {
    const n = normalizeOrigin(entry);
    if (n === null) throw new Error('Invalid ALLOWED_ORIGINS entry: expected scheme://host[:port] (no path).');
    allowed.add(n);
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    const n = normalizeOrigin(origin);
    if (n === null || !allowed.has(n)) {
      forbidden(res, 'Forbidden: invalid Origin header');
      return;
    }
    next();
  };
}
