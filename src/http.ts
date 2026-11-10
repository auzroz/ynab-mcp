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
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { sanitizeErrorMessage } from './utils/sanitize.js';
import { createServerForUser, type UserContext } from './server.js';
import { UserRegistry, headerUserKey } from './services/user-registry.js';
import { SessionManager } from './services/session-manager.js';
import type { HttpConfig } from './config/environment.js';
import { Encryptor } from './crypto.js';
import { createStorage } from './storage/index.js';
import type { GrantedScope, Storage } from './storage/types.js';
import { mountAuthorizationServer, type AuthorizationServer } from './auth/as-router.js';
import { YnabTokenResolver } from './auth/user-session.js';
import { deriveOriginsFromHosts, hostValidation, originValidation } from './middleware/origin-validation.js';
import { MAX_JSON_BODY, mountStages, stage, type RoutePipeline, type StageObserver } from './http/pipeline.js';
import {
  createJobRunner,
  isMcpPath,
  jobs as registeredJobs,
  routes as registeredRoutes,
  type ExtensionContext,
  type JobExtension,
  type JobRunner,
  type RouteExtension,
} from './http/extensions.js';

export { MAX_JSON_BODY } from './http/pipeline.js';
export { OAUTH_LEG_RATE_LIMIT } from './auth/as-router.js';

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

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

/** The app and what its owner starts and stops with it. */
export interface HttpApp {
  app: express.Express;
  /** Live sessions; close() it when the server stops. */
  sessions: SessionManager;
  /** The extension jobs (src/http/extensions.ts): startHttpServer starts them; its close() stops them. */
  jobs: JobRunner;
  /**
   * The authorization server's routes and their stage names, in order,
   * starting with host-validation when that is on (oauth mode; undefined in
   * header mode). Asserted by tests/unit/http-as-pipeline.test.ts.
   */
  asPipeline: readonly RoutePipeline[] | undefined;
}

/** Test hooks and overrides for buildHttpApp; production passes none. */
export interface HttpAppOptions {
  /** Replaces the registered route extensions. */
  routes?: readonly RouteExtension[];
  /** Replaces the registered job extensions. */
  jobs?: readonly JobExtension[];
  /** Reports each named stage as a request enters it. */
  observeStage?: StageObserver | undefined;
}

/**
 * Build the Express app (async because oauth mode initializes storage).
 * Exported for testing without binding a port.
 */
export async function createHttpApp(config: HttpConfig, options: HttpAppOptions = {}): Promise<express.Express> {
  return (await buildHttpApp(config, options)).app;
}

/** Like createHttpApp, also returning the session manager and jobs so their owner can start and stop them. */
export async function buildHttpApp(config: HttpConfig, options: HttpAppOptions = {}): Promise<HttpApp> {
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
  const upstreamStages: string[] = [];
  if (config.enableDnsRebindingProtection) {
    const hosts = config.allowedHosts ?? [];
    upstreamStages.push(
      ...mountStages(
        app,
        undefined,
        [stage('host-validation', hostValidation(hosts, { skipPaths: ['/health'] }))],
        options.observeStage
      )
    );
    app.use('/mcp', originValidation(config.allowedOrigins ?? deriveOriginsFromHosts(hosts)));
  }

  // oauth mode: storage, then the authorization server (src/auth/as-router.ts).
  // Each AS route carries its own bounded parser (and the /oauth legs their
  // limiter, ahead of it), so the AS is mounted before the global JSON parser.
  let storage: Storage | undefined;
  let oauth: { as: AuthorizationServer; resolver: YnabTokenResolver } | undefined;
  if (config.authMode === 'oauth') {
    storage = await buildStorage(config);
    const encryptor = new Encryptor(config.encryptionKey);
    const ynab = {
      clientId: config.oauthClientId as string,
      clientSecret: config.oauthClientSecret as string,
    };
    oauth = {
      as: mountAuthorizationServer(app, { config, storage, encryptor, ynab, observeStage: options.observeStage }),
      resolver: new YnabTokenResolver(storage, encryptor, ynab),
    };
  }
  const asPipeline = oauth?.as.routes.map((r) => ({ route: r.route, stages: [...upstreamStages, ...r.stages] }));

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
    // Unauthenticated: reveals nothing about the mode or the load.
    res.json({ status: 'ok' });
  });

  // Extension routes (src/http/extensions.ts): after host validation, the AS
  // and the JSON parser; before /mcp. Unauthenticated, so they never see a
  // request for /mcp or under it (that goes on to /mcp's own handlers).
  const extensionContext: ExtensionContext = { config, storage };
  const extensionRouter = express.Router();
  for (const route of options.routes ?? registeredRoutes) route.mount(extensionRouter, extensionContext);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isMcpPath(req.path)) {
      next();
      return;
    }
    extensionRouter(req, res, next);
  });
  const jobs = createJobRunner(options.jobs ?? registeredJobs, extensionContext);

  // Resolves the per-session UserContext at `initialize` time.
  let resolveInitContext: (req: Request) => Promise<ContextResult>;
  // RFC 9728 metadata URL advertised in 401 challenges (oauth mode only).
  let resourceMetadataUrl: string | undefined;

  if (oauth) {
    // --- OAuth mode: the AS is mounted above; /mcp takes its bearer tokens ---
    const { provider, resourceServerUrl } = oauth.as;
    const resolver = oauth.resolver;
    resourceMetadataUrl = oauth.as.resourceMetadataUrl;

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
        // Write access needs all of: writes enabled globally (YNAB_READ_ONLY off
        // and YNAB_OAUTH_ALLOW_WRITE on, checked here on every initialize and not
        // only at consent, so a read-write grant from before the operator turned
        // writes off cannot write), a read-write grant on this token (per client grant, not the user's latest consent), and
        // a read-write YNAB token for the user (YNAB enforces that one anyway).
        // The token's level is also part of the session owner (sessionOwner).
        const tokenScope = auth === undefined ? 'read-only' : tokenAccessLevel(auth);
        return {
          ok: true,
          ctx: {
            accessToken: resolver.accessTokenFor(userId),
            defaultBudgetId: config.defaultBudgetId,
            readOnly:
              config.readOnly || !config.allowWrite || tokenScope === 'read-only' || grantedScope === 'read-only',
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

    let lease: ReturnType<typeof registry.acquire> | undefined;
    let bound = false;
    try {
      lease = registry.acquire(result.userKey);
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => admission.commit(sid),
      });
      // Every session teardown (DELETE, idle sweep, eviction, shutdown) goes
      // through the transport's close, which releases the user's hold.
      const held = lease;
      admission.bind(newTransport, sessionOwner(req), () => held.release());
      bound = true;

      const server = createServerForUser(result.ctx, lease.components);
      await server.connect(newTransport);
      await newTransport.handleRequest(req, res, req.body);
    } finally {
      // An initialize that produced no session (refused by the transport, or the
      // server failed to build) holds nothing, and onclose may never run for it.
      admission.cancel();
      // Before bind the admission doesn't know the release, so give it back here.
      if (!bound) lease?.release();
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

  return { app, sessions, jobs, asPipeline };
}

/**
 * Build and start the HTTP server. Returns the Node http.Server; closing it
 * also closes every live session (an open SSE stream would otherwise keep it
 * from ever finishing closing), stops the idle sweep and stops the extension
 * jobs, which start here once storage is ready.
 */
export async function startHttpServer(
  config: HttpConfig,
  options: HttpAppOptions = {}
): Promise<ReturnType<express.Express['listen']>> {
  const { app, sessions, jobs } = await buildHttpApp(config, options);
  // Storage is ready once the app is built.
  jobs.start();
  const onListening = (): void => {
    console.error(`YNAB MCP Server (HTTP, ${config.authMode} auth) listening on port ${config.port}`);
    console.error(
      config.readOnly ? 'READ-ONLY mode (write operations disabled)' : 'WRITE operations ENABLED'
    );
    if (!config.enableDnsRebindingProtection) {
      console.error(
        'WARNING: Host/Origin validation is DISABLED (ENABLE_DNS_REBINDING_PROTECTION=false). This is unsafe: any website can reach this server via DNS rebinding.'
      );
    }
    if (config.authMode === 'oauth') {
      console.error(
        config.readOnly || !config.allowWrite
          ? 'Write policy: connections are read-only (set YNAB_OAUTH_ALLOW_WRITE=true and YNAB_READ_ONLY=false to allow writes)'
          : 'Write policy: connections granted read-write can write (YNAB_OAUTH_ALLOW_WRITE=true)'
      );
    }
    if (config.authMode === 'header') {
      console.error(
        'WARNING: AUTH_MODE=header. Any X-YNAB-Token value is accepted as a user; TLS is required, and OAuth (AUTH_MODE=oauth) is the multi-user mode.'
      );
    }
  };
  const httpServer =
    config.bindHost === undefined ? app.listen(config.port, onListening) : app.listen(config.port, config.bindHost, onListening);
  const closeServer = httpServer.close.bind(httpServer);
  httpServer.close = (callback) => {
    // The streams ended by closing the sessions leave idle keep-alive
    // connections, which would otherwise hold close() open until they time out.
    // The caller's callback runs only once the jobs have stopped too: a job's
    // stop() may be async (finishing a sweep, releasing a lock), and a caller
    // that exits the process from the callback (index.ts) must not cut that short.
    const stopped = Promise.allSettled([sessions.close(), jobs.stop()]);
    void stopped.then(() => httpServer.closeIdleConnections());
    return closeServer((err) => {
      void stopped.then(() => callback?.(err));
    });
  };
  return httpServer;
}
