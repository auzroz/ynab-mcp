/**
 * The authorize-validation stage (#55a): bounds on an /authorize request,
 * checked ahead of the handler (gate G21), plus the refusal of grandfathered
 * clients with a plain-http redirect URI.
 *
 * For a request whose client and redirect URI are known (the handler's own
 * first checks; anything else passes through for the handler's 400 JSON):
 *
 *   1. **Grandfathered clients.** A stored client is checked against today's
 *      registration rules (client-metadata.ts checkStoredClient). One with a
 *      non-loopback `http://` redirect URI is refused here, on this server's
 *      page and never by redirect; its other rule failures are logged once
 *      per process and the client keeps working (#55, batch 3).
 *   2. The redirect URI the handler will use is resolved by its rules.
 *   3. `state`: one string of at most MAX_STATE_LENGTH characters.
 *   4. `code_challenge`: exactly 43 base64url characters (an S256 challenge).
 *   5. `scope`: at most MAX_SCOPES space-separated values. Unknown values are
 *      dropped (UNKNOWN_SCOPE_POLICY), so the handler sees only
 *      KNOWN_SCOPES.
 *
 * A failed bound is an authorization error, redirected to the client with
 * `state` (when it was valid) and `iss` (RFC 6749 section 4.1.2.1, RFC 9207).
 * This stage needs only the client store and so stays as it is when the
 * authorization server moves to oidc-provider (ADR-0002, #47-4).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { checkStoredClient, redirectUriMatches, type ClientMetadataPolicy } from './client-metadata.js';
import { HTML_CONTENT_TYPE, PAGE_HEADERS, renderAuthorizationErrorPage } from './auth-pages.js';
import { withIssuer } from '../middleware/iss-redirect.js';

/** The longest `state` accepted (#55). */
export const MAX_STATE_LENGTH = 512;

/** An S256 PKCE challenge: BASE64URL(SHA-256(verifier)) without padding, always 43 characters. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The most scope values one request may name (#55). */
export const MAX_SCOPES = 5;

/** The scopes this server knows (the AS metadata's scopes_supported). */
export const KNOWN_SCOPES: readonly string[] = ['read-only', 'read-write'];

/**
 * Batch-3 default (#55): what an unknown scope value does. `drop` removes it
 * before the handler sees the request; `refuse` fails the request with
 * `invalid_scope`.
 */
export const UNKNOWN_SCOPE_POLICY: 'drop' | 'refuse' = 'drop';

/** Batch-3 default (#55): refuse a stored client with a plain-http (non-loopback) redirect URI. */
export const REFUSE_PLAIN_HTTP_CLIENTS = true;

/** The stored clients whose rule failures this process has logged, so each is logged once. */
const MAX_LOGGED_CLIENTS = 1000;

/** A client id as logged: ours are UUIDs; anything else is not echoed. */
const loggableId = (id: unknown): string => (typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? id : '(unprintable id)');

/** The client store as this stage needs it. */
export interface AuthorizeClientLookup {
  getClient(clientId: string): object | undefined | Promise<object | undefined>;
}

export interface AuthorizeValidationOptions {
  clients: AuthorizeClientLookup;
  policy: ClientMetadataPolicy;
  /** The issuer, sent as `iss` on error redirects (RFC 9207). */
  issuer: string;
}

/** The request's parameters: the query for GET, the body for POST. */
function paramsOf(req: Request): Record<string, unknown> | undefined {
  const source: unknown = req.method === 'POST' ? req.body : req.query;
  return source !== null && typeof source === 'object' ? (source as Record<string, unknown>) : undefined;
}

/** Replace (or remove) one parameter so the handler reads the new value. */
function setParam(req: Request, name: string, value: string | undefined): void {
  if (req.method === 'POST') {
    const body = req.body as Record<string, unknown>;
    if (value === undefined) delete body[name];
    else body[name] = value;
    return;
  }
  // Express 5 parses req.query from the URL on every read (a getter), so the
  // new value is set as an own property, which the handler then reads.
  const query: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
  if (value === undefined) delete query[name];
  else query[name] = value;
  Object.defineProperty(req, 'query', { value: query, configurable: true, enumerable: true, writable: true });
}

/** The redirect URI the handler will use, by its rules, or undefined when it will refuse the request first. */
function resolveRedirectUri(requested: unknown, registered: unknown): string | undefined {
  if (!Array.isArray(registered)) return undefined;
  const uris = registered.filter((u): u is string => typeof u === 'string');
  let uri: string | undefined;
  if (requested === undefined) uri = uris.length === 1 ? uris[0] : undefined;
  else if (typeof requested === 'string' && uris.some((r) => redirectUriMatches(requested, r))) uri = requested;
  if (uri === undefined || !URL.canParse(uri)) return undefined;
  return uri;
}

/** An OAuth error: its code and a fixed description. */
interface AuthorizationError {
  readonly error: string;
  readonly error_description: string;
}

/** Send an authorization error page (no redirect). */
function sendErrorPage(res: Response, error: string, description: string): void {
  const { status, html } = renderAuthorizationErrorPage({ error, errorDescription: description, returnUrl: undefined });
  for (const [name, value] of Object.entries(PAGE_HEADERS)) res.setHeader(name, value);
  res.setHeader('Content-Type', HTML_CONTENT_TYPE);
  res.status(status).send(html);
}

const PLAIN_HTTP_REFUSED =
  'This application registered a redirect address that uses http to a remote host, which this server no longer accepts. ' +
  'The application needs to register again.';

/** The authorize-validation stage. */
export function authorizeValidation(options: AuthorizeValidationOptions): RequestHandler {
  const { clients, policy, issuer } = options;
  const logged = new Set<string>();
  const logOnce = (clientId: string, message: string): void => {
    if (logged.has(clientId)) return;
    if (logged.size < MAX_LOGGED_CLIENTS) logged.add(clientId);
    console.warn(message);
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Other methods get the handler's 405.
    if (req.method !== 'GET' && req.method !== 'POST') {
      next();
      return;
    }
    const params = paramsOf(req);
    const clientId = params?.['client_id'];
    if (params === undefined || typeof clientId !== 'string') {
      next();
      return;
    }

    let client: Record<string, unknown> | undefined;
    try {
      client = (await clients.getClient(clientId)) as Record<string, unknown> | undefined;
    } catch {
      // Generic on purpose: storage errors can carry connection details.
      res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
      return;
    }
    if (client === undefined) {
      next();
      return;
    }

    // 1. Grandfathered clients (registered before these rules).
    const stored = checkStoredClient(client, policy);
    if (stored.plainHttp && REFUSE_PLAIN_HTTP_CLIENTS) {
      logOnce(
        clientId,
        `[OAuth] Refused client ${loggableId(clientId)} at /authorize: it has a plain-http redirect URI to a non-loopback host. It must register again.`
      );
      sendErrorPage(res, 'invalid_client', PLAIN_HTTP_REFUSED);
      return;
    }
    if (stored.failures.length > 0) {
      logOnce(
        clientId,
        `[OAuth] Client ${loggableId(clientId)} was registered under older rules and fails: ${stored.failures.join('; ')}. ` +
          'It is still accepted; registering it again clears this.'
      );
    }

    // 2. The redirect URI, once the handler would accept the client and it.
    const redirectUri = resolveRedirectUri(params['redirect_uri'], client['redirect_uris']);
    if (redirectUri === undefined) {
      next();
      return;
    }
    /** Redirect an error to the client, with its state once that is known to be valid. */
    const fail = (err: AuthorizationError, clientState?: string): void => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', err.error);
      url.searchParams.set('error_description', err.error_description);
      if (clientState !== undefined && clientState !== '') url.searchParams.set('state', clientState);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, withIssuer(url.href, issuer));
    };

    // 3. state (not echoed when it is the problem).
    const state = params['state'];
    if (state !== undefined && (typeof state !== 'string' || state.length > MAX_STATE_LENGTH)) {
      fail({ error: 'invalid_request', error_description: `state must be one string of at most ${MAX_STATE_LENGTH} characters` });
      return;
    }

    // 4. code_challenge.
    const challenge = params['code_challenge'];
    if (typeof challenge !== 'string' || !CODE_CHALLENGE_PATTERN.test(challenge)) {
      fail({ error: 'invalid_request', error_description: 'code_challenge must be a 43-character S256 challenge' }, state);
      return;
    }

    // 5. scope.
    const scope = params['scope'];
    if (scope !== undefined) {
      if (typeof scope !== 'string') {
        fail({ error: 'invalid_scope', error_description: 'scope must be one string' }, state);
        return;
      }
      const requested = scope.split(' ').filter((s) => s !== '');
      if (requested.length > MAX_SCOPES) {
        fail({ error: 'invalid_scope', error_description: `At most ${MAX_SCOPES} scopes may be requested` }, state);
        return;
      }
      const known = [...new Set(requested)].filter((s) => KNOWN_SCOPES.includes(s));
      if (UNKNOWN_SCOPE_POLICY === 'refuse' && known.length !== new Set(requested).size) {
        fail({ error: 'invalid_scope', error_description: `Supported scopes: ${KNOWN_SCOPES.join(', ')}` }, state);
        return;
      }
      setParam(req, 'scope', known.length > 0 ? known.join(' ') : undefined);
    }
    next();
  };
}
