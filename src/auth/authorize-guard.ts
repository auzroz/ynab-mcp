/**
 * The authorize guard (#55b): an authorization error is redirected back to the
 * client (RFC 6749 section 4.1.2.1) only when its redirect URI is verified
 * (MCP_VERIFIED_REDIRECT_URIS, or loopback while MCP_TRUST_LOOPBACK_REDIRECTS
 * is on; see client-metadata.ts errorsMayRedirect). For every other client
 * the error is shown on this server's own page, with a "Return to <host>"
 * link the user may follow, so the authorization endpoint can't be used as an
 * open redirector: anyone can register a client with any https redirect URI,
 * and before this a malformed /authorize link bounced the browser straight to
 * it from this server's origin.
 *
 * Two stages share this module:
 *   - authorize-validation (authorize-validation.ts) resolves the client and
 *     its redirect URI and records them with setAuthorizeContext(); its own
 *     errors go through sendAuthorizationError();
 *   - authorize-guard (authorizeGuard() below) runs next, ahead of the
 *     handler, and makes sure the handler's own error redirects follow the
 *     same rule. For server-legacy that is captureRedirects()
 *     (authorize-guard-legacy.ts), the one part replaced at #47-4. A
 *     redirect passes only for a verified request and only to that request's
 *     own redirect URI; every other one, and every one without a context
 *     (authorize-validation couldn't resolve the client), becomes the page:
 *     fail closed.
 *
 * Errors before the client and redirect URI are known (unknown client,
 * unregistered redirect URI) were never redirected and stay the handler's
 * 400 JSON.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isReservedScheme } from '../config/http/dcr.js';
import { HTML_CONTENT_TYPE, PAGE_HEADERS, renderAuthorizationErrorPage } from './auth-pages.js';
import { isPlainHttpRedirectUri } from './client-metadata.js';
import { captureRedirects } from './authorize-guard-legacy.js';
import { withIssuer } from '../middleware/iss-redirect.js';

/** What authorize-validation learned about a request, for the guard and for its own errors. */
export interface AuthorizeContext {
  /** The redirect URI this authorization would return to (validated against the client's). */
  readonly redirectUri: string;
  /** Whether errors may be redirected there (the verified-client predicate). */
  readonly mayRedirect: boolean;
  /** The client's `state`, once checked; echoed on error responses. */
  state: string | undefined;
}

const contexts = new WeakMap<Response, AuthorizeContext>();

export function setAuthorizeContext(res: Response, ctx: AuthorizeContext): void {
  contexts.set(res, ctx);
}

export function authorizeContextOf(res: Response): AuthorizeContext | undefined {
  return contexts.get(res);
}

/** An OAuth error: its code and a fixed description. */
export interface AuthorizationError {
  readonly error: string;
  readonly error_description: string;
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** The RFC 6749 section 4.1.2.1 error response URL: error, description, state and iss (RFC 9207). */
export function authorizationErrorUrl(
  redirectUri: string,
  err: AuthorizationError,
  state: string | undefined,
  issuer: string
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', err.error);
  url.searchParams.set('error_description', err.error_description);
  if (state !== undefined && state !== '') url.searchParams.set('state', state);
  return withIssuer(url.href, issuer);
}

/** Whether `location` goes to the request's own redirect URI (same scheme, host and path). */
function targetsRedirectUri(location: string | undefined, ctx: AuthorizeContext): boolean {
  const target = location !== undefined ? parseUrl(location) : undefined;
  const registered = parseUrl(ctx.redirectUri);
  return (
    target !== undefined &&
    registered !== undefined &&
    target.protocol === registered.protocol &&
    target.host === registered.host &&
    target.pathname === registered.pathname
  );
}

/**
 * Whether `location` may be offered as the page's return link: an error
 * response to this request's redirect URI (same scheme, host and path), to a
 * scheme a browser can hand to an app, never plain http to a remote host.
 */
function returnLinkFor(location: string | undefined, ctx: AuthorizeContext | undefined): string | undefined {
  if (location === undefined || ctx === undefined || !targetsRedirectUri(location, ctx)) return undefined;
  const target = parseUrl(location);
  if (target === undefined || !target.searchParams.has('error')) return undefined;
  const scheme = target.protocol.slice(0, -1);
  if (scheme !== 'https' && (scheme === 'http' ? isPlainHttpRedirectUri(location) : isReservedScheme(scheme))) {
    return undefined;
  }
  return target.href;
}

/** The error page that replaces a redirect, as status, headers and body. */
function errorPage(error: unknown, description: unknown, returnUrl: string | undefined) {
  const { status, html } = renderAuthorizationErrorPage({ error, errorDescription: description, returnUrl });
  return { status, headers: { ...PAGE_HEADERS, 'Content-Type': HTML_CONTENT_TYPE }, body: html };
}

/** Send an authorization error page (no redirect). */
export function sendErrorPage(res: Response, error: string, description: string, returnUrl?: string): void {
  const page = errorPage(error, description, returnUrl);
  for (const [name, value] of Object.entries(page.headers)) res.setHeader(name, value);
  res.status(page.status).send(page.body);
}

/**
 * Answer an authorization request with an error: a redirect for a verified
 * client, this server's error page (with a return link) for any other.
 */
export function sendAuthorizationError(
  res: Response,
  ctx: AuthorizeContext,
  err: AuthorizationError,
  issuer: string
): void {
  const location = authorizationErrorUrl(ctx.redirectUri, err, ctx.state, issuer);
  if (ctx.mayRedirect) {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, location);
    return;
  }
  sendErrorPage(res, err.error, err.error_description, returnLinkFor(location, ctx));
}

/**
 * The authorize-guard stage: every redirect the handler sends becomes this
 * server's error page, except, for a request whose errors may redirect, one
 * to that request's own (verified) redirect URI.
 */
export function authorizeGuard(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const ctx = authorizeContextOf(res);
    // server-legacy specific; replaced at #47-4 (see authorize-guard-legacy.ts).
    captureRedirects(
      res,
      (location) => {
        const params = location !== undefined ? parseUrl(location)?.searchParams : undefined;
        return errorPage(params?.get('error'), params?.get('error_description'), returnLinkFor(location, ctx));
      },
      (location) => ctx?.mayRedirect === true && targetsRedirectUri(location, ctx)
    );
    next();
  };
}
