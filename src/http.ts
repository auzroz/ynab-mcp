/**
 * HTTP (remote) transport for the YNAB MCP server.
 *
 * Two auth modes (selected by config):
 *  - `header`  — interim: YNAB token supplied per session via `X-YNAB-Token`
 *                (or the `YNAB_ACCESS_TOKEN` fallback). TLS required.
 *  - `oauth`   — multi-tenant: the server is an OAuth 2.1 Authorization Server
 *                (DCR + PKCE via the SDK) federated to YNAB. Each MCP access
 *                token maps to a YNAB-identified user; per request we resolve and
 *                refresh that user's YNAB token and build an isolated server.
 *
 * In both modes each MCP session gets its own YnabClient, built on its user's
 * rate limiter, cache and audit log (UserRegistry), which all of that user's
 * sessions share and no other user can reach.
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { sanitizeErrorMessage } from './utils/sanitize.js';
import { createServerForUser, type UserContext } from './server.js';
import { UserRegistry, headerUserKey } from './services/user-registry.js';
import { SessionManager } from './services/session-manager.js';
import type { HttpConfig } from './config/environment.js';
import { Encryptor } from './crypto.js';
import { createStorage } from './storage/index.js';
import type { GrantedScope } from './storage/types.js';
import { McpOAuthProvider } from './auth/mcp-provider.js';
import { YnabTokenResolver } from './auth/user-session.js';
import { issOnAuthorizationRedirects } from './middleware/iss-redirect.js';
import { deriveOriginsFromHosts, hostValidation, originValidation } from './middleware/origin-validation.js';

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * Max JSON request body. A maximal 100-transaction ynab_create_transactions payload
 * is on the order of 100KB, so 512kb leaves headroom without accepting multi-MB bodies.
 */
export const MAX_JSON_BODY = '512kb';

/** Select and initialize the configured storage driver. */
async function buildStorage(config: HttpConfig): ReturnType<typeof createStorage> {
  switch (config.storageDriver) {
    case 'sqlite':
      if (!config.sqlitePath) throw new Error('SQLITE_PATH is required for the sqlite storage driver');
      return createStorage({ driver: 'sqlite', path: config.sqlitePath });
    case 'postgres':
      if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the postgres storage driver');
      return createStorage({ driver: 'postgres', connectionString: config.databaseUrl });
    default:
      return createStorage({ driver: 'memory' });
  }
}

/**
 * The access level the request's MCP access token carries (oauth mode), as
 * verifyAccessToken reported it. Anything but `read-write` is read-only.
 */
function tokenAccessLevel(auth: AuthInfo): GrantedScope {
  return auth.extra?.['grantedScope'] === 'read-write' ? 'read-write' : 'read-only';
}

/**
 * Who an oauth-mode session belongs to: the authenticated MCP client and YNAB
 * user, and the access level of the token it was initialized with. Binding the
 * level means a read-only token of the same client and user can't drive a
 * session that a read-write token initialized; a refreshed token of the same
 * level still can.
 *
 * The level is the token's own (from AuthInfo, no extra storage read per
 * request). The other inputs to a session's read-only flag (YNAB_READ_ONLY,
 * the user's YNAB grant) can only make a session stricter than its token, so
 * a request never gets more access through a session than its token grants.
 */
function oauthSessionOwner(req: Request): string | undefined {
  const auth = req.auth;
  const userId = auth?.extra?.['userId'];
  if (auth === undefined || typeof userId !== 'string') return undefined;
  return JSON.stringify([auth.clientId, userId, tokenAccessLevel(auth)]);
}

/**
 * Result of resolving a session's user context and registry key (see
 * UserRegistry), or an HTTP error to return.
 */
type ContextResult =
  | { ok: true; ctx: UserContext; userKey: string }
  | { ok: false; status: number; message: string };

/** Seconds a client is told to wait before retrying an initialize refused at the session cap. */
const SESSION_CAP_RETRY_AFTER_SEC = 30;

/** An unknown, expired, closed or foreign session id: the client should re-initialize (MCP spec). */
function sessionNotFound(res: Response): void {
  res.status(404).json(jsonRpcError(-32001, 'Session not found'));
}

/** The app and the session manager behind it. */
export interface HttpApp {
  app: express.Express;
  /** Live sessions; close() it when the server stops. */
  sessions: SessionManager;
}

/**
 * Build the Express app (async because oauth mode initializes storage).
 * Exported for testing without binding a port.
 */
export async function createHttpApp(config: HttpConfig): Promise<express.Express> {
  return (await buildHttpApp(config)).app;
}

/** Like createHttpApp, also returning the session manager so its owner can shut it down. */
export async function buildHttpApp(config: HttpConfig): Promise<HttpApp> {
  const app = express();
  // Number of reverse-proxy hops to trust for X-Forwarded-* (rate limiting, audit
  // logging). Defaults to 0 (trust none) so a self-hosted, direct-exposed instance
  // can't have its rate limit bypassed by a spoofed header; set TRUST_PROXY to the
  // hop count when running behind a known ingress (e.g. 1 behind a single Traefik).
  app.set('trust proxy', config.trustProxy);

  // Host/Origin validation (DNS rebinding + cross-site requests), the single
  // source of truth for these checks (the SDK transport's own is left off).
  //  - Host is checked on every route except /health (probed by orchestrators
  //    by pod IP). That includes the OAuth endpoints and well-known metadata.
  //  - Origin is checked on /mcp only. The OAuth endpoints carry no ambient
  //    credentials (PKCE / client authentication) and the SDK serves them, and
  //    the well-known metadata, with permissive CORS on purpose so browser-based
  //    MCP clients can discover and register; /mcp is the credentialed,
  //    state-changing surface. The one cookie (the SameSite=Lax consent cookie
  //    the federation legs require) only proves which browser saw the consent
  //    page; it grants nothing by itself.
  if (config.enableDnsRebindingProtection) {
    const hosts = config.allowedHosts ?? [];
    app.use(hostValidation(hosts, { skipPaths: ['/health'] }));
    app.use('/mcp', originValidation(config.allowedOrigins ?? deriveOriginsFromHosts(hosts)));
  }
  app.use(express.json({ limit: MAX_JSON_BODY }));

  const sessions = new SessionManager({
    maxSessions: config.maxSessions,
    maxSessionsPerUser: config.maxSessionsPerUser,
    idleTimeoutMs: config.sessionIdleTimeoutMs,
  });
  const registry = new UserRegistry({
    rateLimitPerHour: config.rateLimitPerHour,
    cacheTtlMs: config.cacheTtlMs,
  });
  // Who a request is from, compared against the session's creator (set per mode).
  let sessionOwner: (req: Request) => string | undefined;

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', authMode: config.authMode, sessions: sessions.size });
  });

  // Resolves the per-session UserContext at `initialize` time.
  let resolveInitContext: (req: Request) => Promise<ContextResult>;
  // RFC 9728 metadata URL advertised in 401 challenges (oauth mode only).
  let resourceMetadataUrl: string | undefined;

  if (config.authMode === 'oauth') {
    // --- OAuth mode: AS endpoints + YNAB federation ---
    const storage = await buildStorage(config);
    const encryptor = new Encryptor(config.encryptionKey);
    const ynab = {
      clientId: config.oauthClientId as string,
      clientSecret: config.oauthClientSecret as string,
    };
    const publicUrl = config.publicUrl as string;
    // The protected resource (RFC 8707 audience) every token is bound to.
    const resourceServerUrl = new URL(config.resourceUrl ?? `${publicUrl}/mcp`);
    // The issuer identifier: published in AS metadata and sent as `iss` on every
    // authorization response (RFC 9207), so both must use this exact string.
    const issuerUrl = new URL(publicUrl);
    const provider = new McpOAuthProvider({
      storage,
      encryptor,
      ynab,
      publicUrl,
      issuer: issuerUrl.href,
      resourceUrl: resourceServerUrl.href,
      allowWrite: config.allowWrite,
      globalReadOnly: config.readOnly,
      accessTokenTtlSec: config.accessTokenTtlSec,
      authCodeTtlSec: config.authCodeTtlSec,
    });
    const resolver = new YnabTokenResolver(storage, encryptor, ynab);

    // Protected-resource metadata (RFC 9728) describes the MCP endpoint, so it is
    // served at the path-aware well-known URL for the resource (e.g.
    // /.well-known/oauth-protected-resource/mcp). The SDK's own PRM lacks
    // bearer_methods_supported, so it is mounted explicitly (first match wins)
    // with the SDK's metadataHandler (CORS: any origin, GET/OPTIONS only).
    const scopesSupported = ['read-only', 'read-write'];
    const resourceName = 'YNAB MCP Server';
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
    const protectedResourceMetadata = {
      resource: resourceServerUrl.href,
      authorization_servers: [issuerUrl.href],
      scopes_supported: scopesSupported,
      bearer_methods_supported: ['header'],
      resource_name: resourceName,
    };
    app.use(new URL(resourceMetadataUrl).pathname, metadataHandler(protectedResourceMetadata));
    // Root alias for clients that probe the non-path-aware location.
    app.use('/.well-known/oauth-protected-resource', metadataHandler(protectedResourceMetadata));

    // AS metadata (RFC 8414) is the SDK's, plus
    // authorization_response_iss_parameter_supported (RFC 9207 section 3), which
    // the SDK does not emit; mounted ahead of the SDK router, which also serves it.
    const authRouterOptions = { provider, issuerUrl, resourceServerUrl, scopesSupported, resourceName };
    const oauthMetadata = {
      ...createOAuthMetadata(authRouterOptions),
      authorization_response_iss_parameter_supported: true,
    };
    app.use('/.well-known/oauth-authorization-server', metadataHandler(oauthMetadata));
    // The SDK's /authorize handler redirects errors to the client without `iss`;
    // this adds it to every redirect from the authorization endpoint (only).
    app.use(
      new URL(oauthMetadata.authorization_endpoint).pathname,
      issOnAuthorizationRedirects(oauthMetadata.issuer)
    );

    // OAuth 2.1 AS endpoints (/authorize, /token, /register, /revoke, metadata).
    app.use(mcpAuthRouter(authRouterOptions));

    // YNAB federation legs. Each requires the consent cookie that /authorize set
    // for this state (provider.consentCookie), so the legs only run in the
    // browser that was shown the consent page.
    const consentNonce = (req: Request, state: string): string | undefined =>
      provider.consentCookie.read(req.header('cookie'), state);
    app.get('/oauth/ynab/start', async (req: Request, res: Response) => {
      try {
        const state = String(req.query['state'] ?? '');
        const scope = req.query['scope'] === 'read-write' ? 'read-write' : 'read-only';
        const url = await provider.startYnabAuthorization(state, scope, consentNonce(req, state));
        res.redirect(url);
      } catch {
        res.status(400).send('Authorization request expired or invalid. Please start over.');
      }
    });
    app.get('/oauth/ynab/callback', async (req: Request, res: Response) => {
      try {
        const code = String(req.query['code'] ?? '');
        const state = String(req.query['state'] ?? '');
        const error = req.query['error'];
        if (state && error !== undefined) {
          // YNAB refused (e.g. the user clicked Deny). Tell the MCP client, with a
          // fixed error code; YNAB's own error text is never forwarded.
          const denial = error === 'access_denied' ? 'access_denied' : 'server_error';
          const redirect = await provider.denyAuthorization(state, denial, consentNonce(req, state));
          res.append('Set-Cookie', provider.consentCookie.clear(state));
          res.redirect(redirect);
          return;
        }
        if (!code || !state) {
          res.status(400).send('Missing code or state.');
          return;
        }
        const redirect = await provider.handleYnabCallback(code, state, consentNonce(req, state));
        res.append('Set-Cookie', provider.consentCookie.clear(state));
        res.redirect(redirect);
      } catch {
        res.status(400).send('Could not complete YNAB authorization. Please start over.');
      }
    });
    // "Cancel" on the consent screen: an access_denied authorization response.
    app.get('/oauth/cancel', async (req: Request, res: Response) => {
      try {
        const state = String(req.query['state'] ?? '');
        if (!state) {
          res.status(400).send('Missing state.');
          return;
        }
        const redirect = await provider.denyAuthorization(state, 'access_denied', consentNonce(req, state));
        res.append('Set-Cookie', provider.consentCookie.clear(state));
        res.redirect(redirect);
      } catch {
        res.status(400).send('Authorization request expired or invalid. Please start over.');
      }
    });

    // Protect the MCP endpoint with the bearer verifier. expectedResource makes the
    // SDK refuse (401 invalid_token) any token whose audience is not this resource;
    // the provider also checks it, and reports 0.3.x tokens as bound to it.
    app.use(
      '/mcp',
      requireBearerAuth({ verifier: provider, resourceMetadataUrl, expectedResource: resourceServerUrl })
    );

    sessionOwner = oauthSessionOwner;
    resolveInitContext = async (req: Request): Promise<ContextResult> => {
      const auth = req.auth;
      const userId = auth?.extra?.['userId'];
      if (typeof userId !== 'string') {
        return { ok: false, status: 401, message: 'Unauthorized: token missing user identity' };
      }
      try {
        // Resolved here to refuse the initialize early and to read the grant;
        // the session itself resolves the token per request (accessTokenFor),
        // so it outlives the ~2h YNAB token and stops when the grant is gone.
        const { grantedScope } = await resolver.resolve(userId);
        // Write access needs all of: writes enabled globally, a read-write grant
        // on this token (per client grant, not the user's latest consent), and
        // a read-write YNAB token for the user (YNAB enforces that one anyway).
        // The token's level is also part of the session owner (sessionOwner).
        const tokenScope = auth === undefined ? 'read-only' : tokenAccessLevel(auth);
        return {
          ok: true,
          ctx: {
            accessToken: resolver.accessTokenFor(userId),
            defaultBudgetId: config.defaultBudgetId,
            readOnly: config.readOnly || tokenScope === 'read-only' || grantedScope === 'read-only',
            rateLimitPerHour: config.rateLimitPerHour,
            cacheTtlMs: config.cacheTtlMs,
          },
          userKey: userId,
        };
      } catch {
        return { ok: false, status: 401, message: 'Unauthorized: could not resolve YNAB access — re-authorize' };
      }
    };
  } else {
    // --- Interim header mode ---
    const effectiveToken = (req: Request): string | undefined =>
      (req.header('x-ynab-token') ?? config.fallbackAccessToken) || undefined;
    // A session belongs to the YNAB token that initialized it (by digest), so
    // a request must present the same effective token to use it.
    sessionOwner = (req: Request): string | undefined => {
      const token = effectiveToken(req);
      return token === undefined ? undefined : headerUserKey(token);
    };
    resolveInitContext = async (req: Request): Promise<ContextResult> => {
      const token = effectiveToken(req);
      if (!token) {
        return { ok: false, status: 401, message: 'Unauthorized: provide a YNAB token via the X-YNAB-Token header' };
      }
      return {
        ok: true,
        ctx: {
          accessToken: token,
          defaultBudgetId: config.defaultBudgetId,
          readOnly: config.readOnly,
          rateLimitPerHour: config.rateLimitPerHour,
          cacheTtlMs: config.cacheTtlMs,
        },
        userKey: headerUserKey(token),
      };
    };
  }

  // Client -> server messages (and streamed responses).
  // MCP 2025-06-18+ removed JSON-RPC batching; reject arrays outright (with or without a session).
  const rejectBatch = (req: Request, res: Response, next: NextFunction): void => {
    if (Array.isArray(req.body)) {
      res
        .status(400)
        .json(jsonRpcError(-32600, 'Invalid Request: JSON-RPC batching is not supported'));
      return;
    }
    next();
  };

  app.post('/mcp', rejectBatch, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const transport = sessions.find(sessionId, sessionOwner(req), res);
    if (transport) {
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // A session id the server doesn't know (expired, closed, foreign): 404, so
    // the client initializes a new session. No id and not an initialize: 400.
    if (sessionId) {
      sessionNotFound(res);
      return;
    }
    if (!isInitializeRequest(req.body)) {
      res.status(400).json(jsonRpcError(-32000, 'Bad Request: no valid session for this request'));
      return;
    }

    const result = await resolveInitContext(req);
    if (!result.ok) {
      if (result.status === 401 && resourceMetadataUrl) {
        res.set(
          'WWW-Authenticate',
          `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
        );
      }
      res.status(result.status).json(jsonRpcError(-32001, result.message));
      return;
    }

    const admission = await sessions.admit(result.userKey);
    if (!admission) {
      res.set('Retry-After', String(SESSION_CAP_RETRY_AFTER_SEC));
      res.status(503).json(jsonRpcError(-32002, 'Service unavailable: too many active sessions, retry later'));
      return;
    }

    const lease = registry.acquire(result.userKey);
    try {
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => admission.commit(sid),
      });
      // Every session teardown (DELETE, idle sweep, eviction, shutdown) goes
      // through the transport's close, which releases the user's hold.
      admission.bind(newTransport, sessionOwner(req), () => lease.release());

      const server = createServerForUser(result.ctx, lease.components);
      await server.connect(newTransport);
      await newTransport.handleRequest(req, res, req.body);
    } finally {
      // An initialize that produced no session (refused by the transport, or the
      // server failed to build) holds nothing, and onclose may never run for it.
      admission.cancel();
    }
  });

  // Server -> client stream (GET) and explicit session teardown (DELETE).
  const sessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header('mcp-session-id');
    if (!sessionId) {
      res.status(400).json(jsonRpcError(-32000, 'Bad Request: missing session id'));
      return;
    }
    const transport = sessions.find(sessionId, sessionOwner(req), res);
    if (!transport) {
      sessionNotFound(res);
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  // Body-parser failures -> JSON-RPC-shaped errors, with no stack traces or internal text.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json(jsonRpcError(-32600, 'Invalid Request: payload too large'));
    } else if (type === 'entity.parse.failed') {
      res.status(400).json(jsonRpcError(-32700, 'Parse error: invalid JSON'));
    } else if (typeof (err as { status?: unknown } | null)?.status === 'number' && (err as { status: number }).status < 500) {
      console.error('[HttpError]', sanitizeErrorMessage(err));
      res.status(400).json(jsonRpcError(-32600, 'Invalid Request'));
    } else {
      // Detailed error is logged internally only; the response stays generic.
      console.error('[HttpError]', sanitizeErrorMessage(err));
      res.status(500).json(jsonRpcError(-32603, 'Internal error'));
    }
  });

  return { app, sessions };
}

/**
 * Build and start the HTTP server. Returns the Node http.Server; closing it
 * also closes every live session (an open SSE stream would otherwise keep it
 * from ever finishing closing) and stops the idle sweep.
 */
export async function startHttpServer(
  config: HttpConfig
): Promise<ReturnType<express.Express['listen']>> {
  const { app, sessions } = await buildHttpApp(config);
  const httpServer = app.listen(config.port, () => {
    console.error(`YNAB MCP Server (HTTP, ${config.authMode} auth) listening on port ${config.port}`);
    console.error(
      config.readOnly ? 'READ-ONLY mode (write operations disabled)' : 'WRITE operations ENABLED'
    );
    if (!config.enableDnsRebindingProtection) {
      console.error(
        'WARNING: Host/Origin validation is DISABLED (ENABLE_DNS_REBINDING_PROTECTION=false). This is unsafe: any website can reach this server via DNS rebinding.'
      );
    }
    if (config.authMode === 'header') {
      console.error(
        'Interim auth: YNAB token via X-YNAB-Token header (TLS required; set the YNAB OAuth env vars to enable OAuth)'
      );
    }
  });
  const closeServer = httpServer.close.bind(httpServer);
  httpServer.close = (callback) => {
    // The streams ended by closing the sessions leave idle keep-alive
    // connections, which would otherwise hold close() open until they time out.
    void sessions.close().then(() => httpServer.closeIdleConnections());
    return closeServer(callback);
  };
  return httpServer;
}
