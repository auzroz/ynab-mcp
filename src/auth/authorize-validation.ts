/**
 * The authorize-validation stage (#55a): bounds on an /authorize request,
 * checked ahead of the handler (gate G21), plus the refusal of grandfathered
 * clients with a plain-http redirect URI.
 *
 * A `client_id` that is missing, empty, longer than MAX_CLIENT_ID_LENGTH or
 * repeated passes through, unlooked-up, for the handler's 400 JSON; so does an
 * unknown client. For a known client:
 *
 *   1. **Grandfathered clients.** A stored client is checked against today's
 *      registration rules (client-metadata.ts checkStoredClient). One with a
 *      non-loopback `http://` redirect URI is refused here, on this server's
 *      page and never by redirect; its other rule failures are logged once
 *      per process and the client keeps working (#55, batch 3).
 *   2. **The redirect URI.** A requested one must match a registered one
 *      exactly, except the port of an `http://` loopback URI
 *      (client-metadata.ts redirectUriMatches); otherwise the request gets the
 *      handler's direct 400, never a redirect. The context (redirect URI and
 *      whether errors may redirect there) is recorded for the authorize-guard
 *      stage.
 *   3. `state`: one string of at most MAX_STATE_LENGTH characters.
 *   4. `code_challenge`: exactly 43 base64url characters (an S256 challenge).
 *   5. `scope`: at most MAX_SCOPES space-separated values. Unknown values are
 *      dropped (UNKNOWN_SCOPE_POLICY), so the handler sees only
 *      KNOWN_SCOPES.
 *
 * A failed bound is an authorization error, sent the way authorize-guard.ts
 * sends every error: redirected to a verified client, shown here otherwise.
 * This stage needs only the client store and so stays as it is when the
 * authorization server moves to oidc-provider (ADR-0002, #47-4).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { checkStoredClient, errorsMayRedirect, redirectUriMatches, type RedirectPolicy } from './client-metadata.js';
import {
  sendAuthorizationError,
  sendErrorPage,
  setAuthorizeContext,
  type AuthorizationError,
  type AuthorizeContext,
} from './authorize-guard.js';

/**
 * The longest `client_id` looked up. Ours are UUIDs (36 characters); a longer
 * or empty value never reaches storage from this stage.
 */
export const MAX_CLIENT_ID_LENGTH = 255;

const ClientIdSchema = z.string().min(1).max(MAX_CLIENT_ID_LENGTH);

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
  policy: RedirectPolicy;
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

/**
 * The redirect URI this authorization returns to:
 *   - `resolved`: the requested one, matching a registered one exactly (or an
 *     http loopback one on another port), or the only registered one when
 *     none was requested;
 *   - `unregistered`: a requested URI that matches none (redirectUriMatches is
 *     stricter than the handler's matcher, so this stage answers it);
 *   - `handler`: anything the handler refuses itself (no URI with several
 *     registered, a value that isn't a URL, a malformed client row).
 */
type RedirectResolution = { kind: 'resolved'; uri: string } | { kind: 'unregistered' } | { kind: 'handler' };

function resolveRedirectUri(requested: unknown, registered: unknown): RedirectResolution {
  if (!Array.isArray(registered)) return { kind: 'handler' };
  const uris = registered.filter((u): u is string => typeof u === 'string');
  if (requested === undefined) {
    const only = uris.length === 1 ? uris[0] : undefined;
    return only !== undefined && URL.canParse(only) ? { kind: 'resolved', uri: only } : { kind: 'handler' };
  }
  if (typeof requested !== 'string' || !URL.canParse(requested)) return { kind: 'handler' };
  return uris.some((r) => redirectUriMatches(requested, r)) ? { kind: 'resolved', uri: requested } : { kind: 'unregistered' };
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
    const parsedClientId = ClientIdSchema.safeParse(params?.['client_id']);
    // Missing, empty, overlong or repeated: the handler's 400, with no lookup here.
    if (params === undefined || !parsedClientId.success) {
      next();
      return;
    }
    const clientId = parsedClientId.data;

    let client: Record<string, unknown> | undefined;
    try {
      client = (await clients.getClient(clientId)) as Record<string, unknown> | undefined;
    } catch {
      // Generic on purpose: storage errors can carry connection details.
      res.setHeader('Cache-Control', 'no-store');
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

    // 2. The context, once the client and redirect URI are accepted. An
    // unregistered redirect URI is refused the way the handler refuses one:
    // a direct 400, never a redirect.
    const resolution = resolveRedirectUri(params['redirect_uri'], client['redirect_uris']);
    if (resolution.kind === 'unregistered') {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json({ error: 'invalid_request', error_description: 'Unregistered redirect_uri' });
      return;
    }
    if (resolution.kind === 'handler') {
      next();
      return;
    }
    const redirectUri = resolution.uri;
    const ctx: AuthorizeContext = { redirectUri, mayRedirect: errorsMayRedirect(redirectUri, policy), state: undefined };
    setAuthorizeContext(res, ctx);
    const fail = (err: AuthorizationError): void => sendAuthorizationError(res, ctx, err, issuer);

    // 3. state (not echoed when it is the problem).
    const state = params['state'];
    if (state !== undefined && (typeof state !== 'string' || state.length > MAX_STATE_LENGTH)) {
      fail({ error: 'invalid_request', error_description: `state must be one string of at most ${MAX_STATE_LENGTH} characters` });
      return;
    }
    ctx.state = state;

    // 4. code_challenge.
    const challenge = params['code_challenge'];
    if (typeof challenge !== 'string' || !CODE_CHALLENGE_PATTERN.test(challenge)) {
      fail({ error: 'invalid_request', error_description: 'code_challenge must be a 43-character S256 challenge' });
      return;
    }

    // 5. scope.
    const scope = params['scope'];
    if (scope !== undefined) {
      if (typeof scope !== 'string') {
        fail({ error: 'invalid_scope', error_description: 'scope must be one string' });
        return;
      }
      const requested = scope.split(' ').filter((s) => s !== '');
      if (requested.length > MAX_SCOPES) {
        fail({ error: 'invalid_scope', error_description: `At most ${MAX_SCOPES} scopes may be requested` });
        return;
      }
      const known = [...new Set(requested)].filter((s) => KNOWN_SCOPES.includes(s));
      if (UNKNOWN_SCOPE_POLICY === 'refuse' && known.length !== new Set(requested).size) {
        fail({ error: 'invalid_scope', error_description: `Supported scopes: ${KNOWN_SCOPES.join(', ')}` });
        return;
      }
      setParam(req, 'scope', known.length > 0 ? known.join(' ') : undefined);
    }
    next();
  };
}
