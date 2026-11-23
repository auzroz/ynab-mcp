/**
 * The oidc-provider configuration (ADR-0002 D1, D2, D7): one `Provider`
 * serving `/authorize`, `/token`, `/register`, `/revoke`, `/jwks` and the RFC
 * 8414 and OIDC discovery documents, over the #47-1 adapter.
 *
 * src/auth/as-router.ts mounts {@link asLibraryHandler} as the last stage
 * (`as-library`) of each AS route, behind D8's stages, and the interaction
 * router (./interaction.ts) under `/oauth` (#47-4). The provider tests also
 * run it on an Express app of their own, as the spike did.
 *
 * What D2 fixes, and where:
 *   - Features: registration (no initial access token), revocation and
 *     resource indicators on; everything else off, as in
 *     {@link CLIENT_SCHEMA_CONFIGURATION}, which is spread first so a client
 *     M4 converted is one this provider accepts.
 *   - Resource indicators: the one MCP resource is the default, the only
 *     resource {@link getResourceServerInfo} accepts (anything else is
 *     `invalid_target`), and the opaque access token's audience.
 *   - PKCE always (S256 is the library's only method). Refresh tokens rotate
 *     on every use and never expire with the session.
 *   - TTLs: access tokens `MCP_ACCESS_TOKEN_TTL_SEC`; codes, interactions and
 *     sessions `authCodeTtlSec`; refresh tokens the idle window capped by the
 *     absolute lifetime from the family's start (`iiat`) and by the grant's
 *     own expiry; grants the absolute lifetime plus the sign-in window, so a
 *     grant outlives every token issued under it and a token-less grant still
 *     expires (#113).
 *   - `loadExistingGrant` returns only the grant the current interaction just
 *     created: no silent sign-in, and a grant left without tokens (after an
 *     account deletion raced a sign-in, #113) is never picked up again.
 *   - `renderError` answers pre-redirect errors as `{ error, error_description }`
 *     JSON (400, or 500 for `server_error`), as today.
 *   - Cookies are signed with a key derived from `ENCRYPTION_KEY` (HKDF, no new
 *     setting) and `Secure` when `PUBLIC_URL` is https.
 *   - `sectorIdentifierUriValidate` is off and registration refuses
 *     `sector_identifier_uri`, so neither DCR nor `Client.find` ever fetches a
 *     URL a client named (#113's third note).
 *   - The client configuration endpoint (`GET /register/:id`), which the
 *     library serves whenever registration is on, is not served, and the DCR
 *     response doesn't name it: the SDK had none, and it would return the
 *     stored `s256.` hash as `client_secret`.
 *
 * The pre-middleware ({@link requestNormalizer}, `provider.use`, a documented
 * extension point) does what the library has no setting for:
 *   - D7: `scope` on `/authorize` becomes `read-only read-write` when it is
 *     absent or names `read-write`, else `read-only`; `openid` and every other
 *     value are dropped (#55's drop policy), and so are the parameters that
 *     need `openid` (`nonce`, `max_age`, ...), which the SDK ignored.
 *   - A `resource` on `/authorize` and `/token` that names the MCP resource in
 *     another spelling (`isSameResource`: case, default port, one trailing `/`)
 *     becomes the canonical string, so the exact check accepts it as today.
 *   - The library builds every URL from the request's origin, so the origin is
 *     pinned to `PUBLIC_URL` (as the SDK's metadata was) and the client address
 *     is Express's `req.ip`, which follows `TRUST_PROXY`.
 *   - The browser's library session cookie is ignored on `/authorize` and its
 *     resume route. Sessions carry nothing across authorizations (D2: every
 *     authorization goes through YNAB), and a session left by another YNAB
 *     user would otherwise send the browser to the disabled logout prompt.
 *
 * **A refresh is not one transaction (#113, review item 4).** The library
 * consumes the presented refresh token, then saves its successor and the
 * access token, in three adapter calls. That is safe because each one fails
 * closed: the consume is a compare-and-set, so of two refreshes of one token
 * only one consumes it and the other revokes the whole grant in the same
 * step; and a token is saved only while its grant row exists, so the winner's
 * successors are refused (or deleted with the grant if they were saved
 * first). Two refreshes can therefore never both leave a live token. A crash
 * between the consume and the saves leaves the client without a refresh
 * token: it signs in again, nothing is reusable. Wrapping the three calls in
 * one storage transaction would need a hook the library doesn't have.
 *
 * `/authorize` is GET only (the library serves POST there only with
 * `enableHttpPostMethods`, which needs `SameSite=None` cookies; it is off).
 * On `/token` the resource is read from the parsed body Express's
 * `bounded-parser` stage leaves on `req.body` (D8); a body the library parses
 * itself is not normalized, and its resource must then be exact.
 *
 * The normalizer matches on the full path, so the library must be mounted
 * through {@link asLibraryHandler}: without it Express strips the mount path,
 * and D7 would be skipped silently.
 */

import { hkdfSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, RequestHandler } from 'express';
import Provider, { errors } from 'oidc-provider';
import type { Configuration, KoaContextWithOIDC, ResourceServer } from 'oidc-provider';
import { parseEncryptionKey } from '../../crypto.js';
import type { OAuthRowStore } from '../../storage/types.js';
import type { LibraryKeyDeriver } from '../token-hash.js';
import { canonicalResource, isSameResource } from '../resource.js';
import { KNOWN_SCOPES } from '../authorize-validation.js';
import { retentionPolicy, type RetentionPolicy } from '../retention-defaults.js';
import { sanitizeErrorMessage } from '../../utils/sanitize.js';
import { createOidcAdapter } from './adapter.js';
import { CLIENT_SCHEMA_CONFIGURATION, ephemeralSigningKeys } from './client-schema.js';

/** The library's routes (D2), as today's SDK served them. */
export const OIDC_ROUTES = {
  authorization: '/authorize',
  token: '/token',
  registration: '/register',
  revocation: '/revoke',
  jwks: '/jwks',
} as const;

/** The discovery documents the library serves (D2). */
export const DISCOVERY_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'] as const;

/** Where the interaction router is mounted; the library sends the browser to `<this>/<uid>` (D3). */
export const INTERACTION_BASE_PATH = '/oauth/interaction';

/** The scope every request without one gets (D7): both levels, so the consent page offers both. */
export const FULL_SCOPE = 'read-only read-write';

/**
 * Authorization parameters that only mean something with `openid`, which D7
 * drops: the library would refuse them (`invalid_request`), and the SDK
 * ignored them, so they are dropped too.
 */
const OIDC_ONLY_PARAMS = ['nonce', 'max_age', 'acr_values', 'claims', 'claims_locales', 'id_token_hint'] as const;

/**
 * `response_mode`, which the SDK ignored (it always answered with a query
 * redirect): dropped, so the library's answer is always a query redirect the
 * authorize guard can judge, never a page that posts to the client (#47-4).
 */
const IGNORED_AUTHORIZE_PARAMS = ['response_mode'] as const;

/** The library's session cookie and its signature (`cookies.names.session`, default). */
const SESSION_COOKIES = new Set(['_session', '_session.sig']);

/** HKDF info of the cookie-signing key: its own, so it shares no key with the pepper or the encryption. */
const COOKIE_KEY_INFO = 'ynab-mcp/oidc-cookie-keys/v1';

export interface OidcProviderOptions {
  /** The `oauth_rows` store (a `Storage`). */
  store: OAuthRowStore;
  /** The token hasher storage was opened with (#52). */
  keys: LibraryKeyDeriver;
  /** `PUBLIC_URL`, without a trailing slash. */
  publicUrl: string;
  /** `MCP_RESOURCE_URL`; defaults to `publicUrl` + `/mcp`. */
  resourceUrl?: string | undefined;
  /** `ENCRYPTION_KEY`: the cookie-signing key is derived from it. */
  encryptionKey: string;
  accessTokenTtlSec: number;
  /** `MCP_AUTH_CODE_TTL_SEC`: codes, interactions and sessions. */
  authCodeTtlSec: number;
  /** STOR-1 and #54's windows; the defaults are in retention-defaults.ts. */
  retention?: Partial<RetentionPolicy> | undefined;
  /** The adapter's clock (epoch ms); tests only. */
  now?: (() => number) | undefined;
}

export interface OidcProvider {
  provider: Provider;
  /** The issuer identifier, as published and sent as `iss` (RFC 9207). */
  issuer: string;
  /** The canonical MCP resource: the only audience. */
  resource: string;
}

/** The scope D7 sends the library for what a client asked at `/authorize`; undefined leaves a non-string alone. */
export function normalizeAuthorizeScope(raw: unknown): string | undefined {
  if (raw !== undefined && typeof raw !== 'string') return undefined;
  const words = new Set((raw ?? '').split(' ').filter((w) => KNOWN_SCOPES.includes(w)));
  return words.has('read-write') || words.size === 0 ? FULL_SCOPE : 'read-only';
}

/** A `resource` value with every spelling of the MCP resource replaced by its canonical form. */
function canonicalizeResource(raw: unknown, resource: string): unknown {
  const one = (value: unknown): unknown =>
    typeof value === 'string' && isSameResource(value, resource) ? resource : value;
  return Array.isArray(raw) ? raw.map(one) : one(raw);
}

/** The cookie `Cookie` header without the library's session cookie. */
function withoutSessionCookie(header: string): string {
  return header
    .split(';')
    .filter((pair) => !SESSION_COOKIES.has(pair.split('=')[0]?.trim() ?? ''))
    .join(';');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface NormalizerDeps {
  resource: string;
  publicUrl: URL;
}

/** The provider's pre-middleware (see the file comment). */
function requestNormalizer({ resource, publicUrl }: NormalizerDeps) {
  const protocol = publicUrl.protocol.slice(0, -1);
  const host = publicUrl.host;
  return async (ctx: KoaContextWithOIDC, next: () => Promise<void>): Promise<void> => {
    const req = ctx.req as IncomingMessage & { ip?: unknown; body?: unknown };
    // The library's URLs (discovery, redirects, the resume URL, cookie paths) use PUBLIC_URL's origin,
    // and its client address is Express's (TRUST_PROXY). Each header is replaced, never appended to,
    // so nothing a client sends in them reaches the library.
    const ip = typeof req.ip === 'string' ? req.ip : (req.socket.remoteAddress ?? '');
    req.headers['x-forwarded-proto'] = protocol;
    req.headers['x-forwarded-host'] = host;
    req.headers['x-forwarded-for'] = ip;
    ctx.request.ip = ip;

    const path = ctx.path;
    const { authorization, token, registration } = OIDC_ROUTES;
    const body = isRecord(req.body) ? req.body : undefined;

    // The library's client configuration endpoint (GET /register/:id, on with registration): the SDK had
    // none, and it would hand the client its stored `s256.` hash as `client_secret`. Not served.
    if (path.startsWith(`${registration}/`)) {
      ctx.status = 404;
      ctx.set('Cache-Control', 'no-store');
      ctx.body = { error: 'invalid_request', error_description: 'Client configuration endpoint is not supported' };
      return;
    }

    if (path === authorization || path.startsWith(`${authorization}/`)) {
      const cookie = req.headers.cookie;
      if (typeof cookie === 'string') req.headers.cookie = withoutSessionCookie(cookie);
    }

    // GET only: the library serves POST /authorize only with `enableHttpPostMethods`, which needs
    // SameSite=None cookies, so it is off and a POST is the library's 404.
    if (path === authorization && ctx.method === 'GET') {
      const params: Record<string, unknown> = { ...ctx.query };
      const scope = normalizeAuthorizeScope(params['scope']);
      if (scope !== undefined) params['scope'] = scope;
      if (params['resource'] !== undefined) params['resource'] = canonicalizeResource(params['resource'], resource);
      for (const name of [...OIDC_ONLY_PARAMS, ...IGNORED_AUTHORIZE_PARAMS]) delete params[name];
      ctx.query = params as typeof ctx.query;
    } else if (path === token && ctx.method === 'POST' && body && body['resource'] !== undefined) {
      body['resource'] = canonicalizeResource(body['resource'], resource);
    } else if (path === registration && ctx.method === 'POST' && body && 'sector_identifier_uri' in body) {
      // Pairwise subjects are off, and the field would make the library fetch a URL the client chose.
      ctx.status = 400;
      ctx.set('Cache-Control', 'no-store');
      ctx.body = { error: 'invalid_client_metadata', error_description: 'sector_identifier_uri is not supported' };
      return;
    }

    await next();

    // Discovery lists the MCP scopes, as the SDK's metadata did, not the library's OIDC scopes.
    if ((DISCOVERY_PATHS as readonly string[]).includes(path) && isRecord(ctx.body)) {
      ctx.body = { ...ctx.body, scopes_supported: [...KNOWN_SCOPES] };
    }
    // The DCR response doesn't point at the configuration endpoint, which isn't served.
    if (path === registration && ctx.status === 201 && isRecord(ctx.body)) {
      const { registration_access_token: _token, registration_client_uri: _uri, ...client } = ctx.body;
      ctx.body = client;
    }
  };
}

/** The cookie-signing key: HKDF-SHA256 of `ENCRYPTION_KEY` with its own info string. */
export function cookieSigningKey(encryptionKey: string): string {
  const ikm = parseEncryptionKey(encryptionKey);
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), COOKIE_KEY_INFO, 32)).toString('base64url');
}

const epochSec = (): number => Math.floor(Date.now() / 1000);

/** A TTL the library accepts: a positive integer (it throws, as a 500, on anything else). */
const positive = (seconds: number): number => Math.max(1, Math.floor(seconds));

/** Build the provider (D2). See the file comment. */
export function createOidcProvider(options: OidcProviderOptions): OidcProvider {
  const publicUrl = new URL(options.publicUrl);
  const resource = canonicalResource(options.resourceUrl ?? `${options.publicUrl}/mcp`);
  if (resource === undefined) throw new Error('Invalid MCP resource URL');
  // Today's issuer: what the SDK's metadata published, so `iss` doesn't change for clients.
  const issuer = publicUrl.href;
  const retention = retentionPolicy(options.retention);
  const { accessTokenTtlSec, authCodeTtlSec } = options;
  const absoluteSec = retention.refreshTokenTtlMs / 1000;
  const idleSec = retention.refreshTokenIdleMs / 1000;
  const secure = publicUrl.protocol === 'https:';
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure, signed: true };

  const resourceServer: ResourceServer = {
    scope: FULL_SCOPE,
    audience: resource,
    accessTokenFormat: 'opaque',
    accessTokenTTL: accessTokenTtlSec,
  };

  const configuration: Configuration = {
    ...CLIENT_SCHEMA_CONFIGURATION,
    adapter: createOidcAdapter({
      store: options.store,
      keys: options.keys,
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
    jwks: ephemeralSigningKeys(),
    routes: { ...OIDC_ROUTES },
    // OIDC's own scope only (resource scopes come from the resource server); D7 drops it from requests.
    scopes: ['openid'],
    pkce: { required: () => true },
    features: {
      ...CLIENT_SCHEMA_CONFIGURATION.features,
      registration: { enabled: true, initialAccessToken: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        getResourceServerInfo: (_ctx, indicator) => {
          // The pre-middleware already turned every other spelling of the resource into this one.
          if (indicator !== resource) throw new errors.InvalidTarget();
          return resourceServer;
        },
        useGrantedResource: () => true,
      },
    },
    rotateRefreshToken: true,
    expiresWithSession: () => false,
    ttl: {
      AccessToken: accessTokenTtlSec,
      AuthorizationCode: authCodeTtlSec,
      Interaction: authCodeTtlSec,
      Session: authCodeTtlSec,
      Grant: positive(absoluteSec + 2 * authCodeTtlSec),
      RefreshToken: (ctx, token) => {
        const now = epochSec();
        const iiat = typeof token.iiat === 'number' ? token.iiat : now;
        let ttl = Math.min(idleSec, iiat + absoluteSec - now);
        const grantExp = (ctx as KoaContextWithOIDC | undefined)?.oidc?.entities.Grant?.exp;
        if (typeof grantExp === 'number') ttl = Math.min(ttl, grantExp - now);
        return positive(ttl);
      },
    },
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      if (typeof grantId !== 'string') return undefined;
      const grant = await ctx.oidc.provider.Grant.find(grantId);
      // The library checks the account and client too; refusing here keeps a mismatch from being a 500.
      if (!grant || grant.clientId !== ctx.oidc.client?.clientId || grant.accountId !== ctx.oidc.session?.accountId) {
        return undefined;
      }
      return grant;
    },
    // The account is the YNAB user id. STOR-1's user join is the adapter's: a token whose user is gone is unknown.
    findAccount: (_ctx, sub) => ({ accountId: sub, claims: () => ({ sub }) }),
    // Absolute, under PUBLIC_URL, as the interaction's own links and the YNAB callback are
    // (a PUBLIC_URL with a path then reaches /oauth the same way for every leg).
    interactions: { url: (_ctx, interaction) => `${options.publicUrl}${INTERACTION_BASE_PATH}/${interaction.uid}` },
    cookies: { keys: [cookieSigningKey(options.encryptionKey)], long: cookieOptions, short: cookieOptions },
    // Our cors-origin stage answers CORS on /token, /revoke and /register (D2, D8); this is the backstop.
    clientBasedCORS: () => true,
    sectorIdentifierUriValidate: () => false,
    renderError: (ctx, out) => {
      ctx.status = out.error === 'server_error' ? 500 : 400;
      ctx.type = 'application/json';
      ctx.set('Cache-Control', 'no-store');
      ctx.body = { error: out.error, error_description: out.error_description };
    },
  };

  const provider = new Provider(issuer, configuration);
  // Headers are pinned by the pre-middleware, and the client address comes from Express (TRUST_PROXY).
  provider.proxy = true;
  provider.use(requestNormalizer({ resource, publicUrl }));
  // The library's unexpected errors (a refused code save is one): logged sanitized, never sent.
  provider.on('server_error', (_ctx: unknown, err: unknown) => {
    console.error('[OAuth] Authorization server error:', sanitizeErrorMessage(err));
  });
  return { provider, issuer, resource };
}

/**
 * D1's `as-library` stage: hand the request to the library with the URL it
 * was sent to (Express strips a mount path from `req.url`).
 */
export function asLibraryHandler(provider: Provider): RequestHandler {
  const callback = provider.callback() as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  return (req: Request, res) => {
    req.url = req.originalUrl;
    req.baseUrl = '';
    void callback(req, res);
  };
}
