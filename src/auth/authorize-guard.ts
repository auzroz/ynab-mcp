/**
 * The authorize guard (#55b): an authorization error is redirected back to the
 * client (RFC 6749 section 4.1.2.1) only when its redirect URI is verified
 * (MCP_VERIFIED_REDIRECT_URIS, or loopback while MCP_TRUST_LOOPBACK_REDIRECTS
 * is on; see client-metadata.ts errorsMayRedirect). For every other client
 * the error is shown on this server's own page, with a "Return to <host>"
 * link the user may follow, so the authorization endpoint can't be used as an
 * open redirector: anyone can register a client with any https redirect URI,
 * and a malformed /authorize link would otherwise bounce the browser straight
 * to it from this server's origin.
 *
 * Three parts share this module:
 *   - authorize-validation (authorize-validation.ts) resolves the client and
 *     its redirect URI and records them with setAuthorizeContext(); its own
 *     errors go through sendAuthorizationError();
 *   - the authorize-guard stage (authorizeGuard() below) runs next, ahead of
 *     `as-library`, and pre-validates every parameter oidc-provider would
 *     refuse with an error redirect once it has accepted the client and the
 *     redirect URI (ADR-0002 D14): repeated parameters, request objects,
 *     `response_type`, `code_challenge_method`, `prompt` (`prompt=none` is
 *     `login_required`: every authorization needs the consent page and YNAB)
 *     and `resource`. Each is answered the guarded way, before the library
 *     sees the request. `response_mode` and the OIDC-only parameters are
 *     dropped by the provider's normalizer (provider.ts, D7), so the
 *     authorization response is always a query redirect;
 *   - the redirect net (authorizeRedirectGuard(), a `provider.use`
 *     middleware) is the fail-closed backstop for anything the stage doesn't
 *     foresee: after the library has answered the initial `/authorize`
 *     request, the answer may be a redirect to this server's own interaction
 *     (the consent page), a redirect to the request's own redirect URI when
 *     its errors may redirect, or an error that isn't a redirect (the
 *     library's JSON `renderError`). Anything else, including a redirect
 *     without a context (authorize-validation couldn't resolve the client)
 *     and a page that would post to the client, becomes the error page. Koa
 *     sends the response only after every middleware has returned, so the
 *     answer is replaced before anything is written.
 *
 * The resume route (`/authorize/:uid`, where the library sends the browser
 * back after the consent page) is not guarded: it redirects the user's own
 * decision on the consent page, which names where it returns to (Cancel and a
 * YNAB denial are `access_denied`), as the SDK-era `/oauth/cancel` did.
 *
 * Errors before the client and redirect URI are known (unknown client,
 * unregistered redirect URI) are never redirected: they are JSON 400s.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { KoaContextWithOIDC } from 'oidc-provider';
import { isReservedScheme } from '../config/http/dcr.js';
import { HTML_CONTENT_TYPE, PAGE_HEADERS, renderAuthorizationErrorPage } from './auth-pages.js';
import { isPlainHttpRedirectUri } from './client-metadata.js';
import { isSameResource } from './resource.js';

/** What authorize-validation learned about a request, for the guard and for its own errors. */
export interface AuthorizeContext {
  /** The redirect URI this authorization would return to (validated against the client's). */
  readonly redirectUri: string;
  /** Whether errors may be redirected there (the verified-client predicate). */
  readonly mayRedirect: boolean;
  /** The client's `state`, once checked; echoed on error responses. */
  state: string | undefined;
}

/** Keyed by the Node response, which Express and the library's Koa context share. */
const contexts = new WeakMap<object, AuthorizeContext>();

export function setAuthorizeContext(res: Response, ctx: AuthorizeContext): void {
  contexts.set(res, ctx);
}

export function authorizeContextOf(res: object): AuthorizeContext | undefined {
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

/**
 * RFC 9207: `redirectUrl` with `iss=<issuer>` set in its query. Other query
 * parameters are kept; an `iss` already present is replaced, never duplicated.
 * A URL that doesn't parse as absolute is returned unchanged.
 */
export function withIssuer(redirectUrl: string, issuer: string): string {
  const url = parseUrl(redirectUrl);
  if (url === undefined) return redirectUrl;
  url.searchParams.set('iss', issuer);
  return url.href;
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

/** Parameters that may be sent more than once (RFC 8707: `resource`); the library refuses any other repeat. */
const REPEATABLE = new Set(['resource']);

/** Request objects and client metadata by value: the library supports none of them. */
const UNSUPPORTED: ReadonlyArray<readonly [string, string]> = [
  ['request', 'request_not_supported'],
  ['request_uri', 'request_uri_not_supported'],
  ['registration', 'registration_not_supported'],
];

/** The `prompt` values the library accepts. */
const PROMPTS = new Set(['none', 'login', 'consent']);

export interface AuthorizeGuardOptions {
  /** The issuer, sent as `iss` on error redirects (RFC 9207). */
  issuer: string;
  /** The canonical MCP resource: the only one a `resource` may name. */
  resource: string;
}

/** The first parameter the library would refuse with an error redirect, or undefined. */
export function libraryParameterError(
  query: Readonly<Record<string, unknown>>,
  resource: string
): AuthorizationError | undefined {
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value) && !REPEATABLE.has(name)) {
      return { error: 'invalid_request', error_description: `'${name}' parameter must not be provided more than once` };
    }
  }
  for (const [name, error] of UNSUPPORTED) {
    if (query[name] !== undefined) return { error, error_description: `${name} parameter is not supported` };
  }
  const responseType = query['response_type'];
  if (responseType === undefined) {
    return { error: 'invalid_request', error_description: "missing required parameter 'response_type'" };
  }
  if (responseType !== 'code') {
    return { error: 'unsupported_response_type', error_description: 'response_type must be code' };
  }
  if (query['code_challenge_method'] !== 'S256') {
    return { error: 'invalid_request', error_description: 'code_challenge_method must be S256' };
  }
  const prompt = query['prompt'];
  if (prompt !== undefined) {
    const prompts = typeof prompt === 'string' ? prompt.split(' ').filter((p) => p !== '') : [];
    if (prompts.length === 0 || prompts.some((p) => !PROMPTS.has(p))) {
      return { error: 'invalid_request', error_description: 'unsupported prompt value requested' };
    }
    if (prompts.includes('none')) {
      // Every authorization shows the consent page and goes through YNAB (ADR-0002 D2).
      return prompts.length === 1
        ? { error: 'login_required', error_description: 'End-User authentication is required' }
        : { error: 'invalid_request', error_description: 'prompt none must only be used alone' };
    }
  }
  const requested = query['resource'];
  if (requested !== undefined) {
    const values = Array.isArray(requested) ? requested : [requested];
    if (values.some((r) => typeof r !== 'string' || !isSameResource(r, resource))) {
      return { error: 'invalid_target', error_description: 'The requested resource is not served by this server' };
    }
  }
  return undefined;
}

/**
 * The authorize-guard stage: the library's own refusals, answered the guarded
 * way before it runs. Only the initial request (`GET /authorize`, the mount's
 * root) with a context; the resume route and a request authorize-validation
 * couldn't resolve go on (the redirect net covers them).
 */
export function authorizeGuard(options: AuthorizeGuardOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = authorizeContextOf(res);
    if (req.method !== 'GET' || req.path !== '/' || ctx === undefined) {
      next();
      return;
    }
    const err = libraryParameterError(req.query as Record<string, unknown>, options.resource);
    if (err !== undefined) {
      sendAuthorizationError(res, ctx, err, options.issuer);
      return;
    }
    next();
  };
}

export interface AuthorizeRedirectGuardOptions {
  /** `PUBLIC_URL`, without a trailing slash. */
  publicUrl: string;
  /** The library's authorization route (`/authorize`). */
  authorizationPath: string;
  /** Where the library sends the browser for the consent page (`/oauth/interaction`). */
  interactionPath: string;
}

/** Whether `location` (absolute or relative) is this server's interaction (the consent page). */
function isInteraction(location: string, publicUrl: URL, interactionPath: string): boolean {
  let target: URL;
  try {
    target = new URL(location, publicUrl);
  } catch {
    return false;
  }
  return target.origin === publicUrl.origin && target.pathname.startsWith(`${interactionPath}/`);
}

/**
 * The redirect net (see the file comment): a `provider.use` middleware that
 * replaces any answer to the initial `/authorize` request other than the
 * consent page's redirect, a permitted error redirect or a non-redirect error
 * with this server's error page.
 */
export function authorizeRedirectGuard(options: AuthorizeRedirectGuardOptions) {
  const publicUrl = new URL(options.publicUrl);
  return async (ctx: KoaContextWithOIDC, next: () => Promise<void>): Promise<void> => {
    await next();
    if (ctx.path !== options.authorizationPath) return;
    const status = ctx.status;
    const redirect = status >= 300 && status < 400;
    // An error the library rendered itself (renderError: JSON, never a redirect).
    if (!redirect && (status < 200 || status >= 300)) return;
    const location = redirect ? ctx.response.get('Location') || undefined : undefined;
    if (location !== undefined && isInteraction(location, publicUrl, options.interactionPath)) return;
    const authorize = authorizeContextOf(ctx.res);
    if (location !== undefined && authorize?.mayRedirect === true && targetsRedirectUri(location, authorize)) return;

    const params = location !== undefined ? parseUrl(location)?.searchParams : undefined;
    const page = errorPage(
      params?.get('error') ?? 'server_error',
      params?.get('error_description') ?? 'The authorization request could not be completed',
      returnLinkFor(location, authorize)
    );
    ctx.remove('Location');
    ctx.remove('Refresh');
    ctx.remove('Link');
    for (const [name, value] of Object.entries(page.headers)) ctx.set(name, value);
    ctx.status = page.status;
    ctx.body = page.body;
    // Koa sets a string body's type to text/plain or text/html; the page's own wins.
    ctx.type = HTML_CONTENT_TYPE;
  };
}
