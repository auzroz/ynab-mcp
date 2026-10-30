/**
 * RFC 9207 (OAuth 2.0 Authorization Server Issuer Identification): every
 * authorization response carries `iss`, the issuer identifier exactly as it
 * appears in the authorization server metadata, so a client talking to several
 * authorization servers can detect a mix-up attack.
 *
 * The provider adds `iss` to the redirects it builds itself (see
 * McpOAuthProvider). The SDK's `/authorize` handler builds its own error
 * redirects (invalid_request, invalid_target, server_error, ...) without `iss`,
 * so {@link issOnAuthorizationRedirects} is mounted on the authorization
 * endpoint to add it there.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Return `redirectUrl` with `iss=<issuer>` set in its query. Existing query
 * parameters (code, state, error, error_description, and any query the client
 * registered in its redirect URI) are kept; an `iss` already present is
 * replaced, never duplicated. A URL that does not parse as absolute (a relative
 * path) is returned unchanged: it cannot be a client redirect URI.
 */
export function withIssuer(redirectUrl: string, issuer: string): string {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return redirectUrl;
  }
  url.searchParams.set('iss', issuer);
  return url.href;
}

/**
 * Middleware for the authorization endpoint only. It wraps `res.location`, which
 * Express's `res.redirect` also goes through, so every redirect the SDK's
 * authorize handler sends gets `iss` and the redirect body names the same URL as
 * the `Location` header.
 *
 * Scoping it to the authorization endpoint is the guard: RFC 6749 section 4.1.2
 * defines every redirect from that endpoint as an authorization response to the
 * client's validated redirect URI. The SDK answers invalid `client_id` /
 * `redirect_uri` with a direct 400, never a redirect, and the redirect to YNAB
 * is sent from `/oauth/ynab/start`, which this is not mounted on.
 */
export function issOnAuthorizationRedirects(issuer: string): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const location = res.location.bind(res);
    res.location = ((url: string) => location(withIssuer(url, issuer))) as Response['location'];
    next();
  };
}
