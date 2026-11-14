/**
 * HTTP (remote) transport for the YNAB MCP server.
 *
 * Two auth modes (selected by config):
 *  - `header`  — interim: YNAB token supplied per request via `X-YNAB-Token`
 *                (or the `YNAB_ACCESS_TOKEN` fallback). TLS required.
 *  - `oauth`   — multi-tenant: the server is an OAuth 2.1 Authorization Server
 *                (DCR + PKCE via the SDK) federated to YNAB. Each MCP access
 *                token maps to a YNAB-identified user; per request we resolve and
 *                refresh that user's YNAB token and build an isolated server.
 *
 * /mcp is stateless (ADR-0001): no Mcp-Session-Id, no session store. Every
 * request runs the pipeline below and gets a fresh server from the factory,
 * through `createMcpHandler(factory, { legacy: 'stateless' })`, which serves
 * 2026-07-28 requests on its modern leg and 2025-era ones on its stateless
 * legacy leg. Each request's YnabClient is built on its user's rate limiter,
 * caches and audit log (UserRegistry), which all of that user's requests share
 * and no other user can reach.
 *
 * The /mcp pipeline, in order (ADR-0001, binding; asserted by
 * tests/unit/http-mcp-pipeline.test.ts):
 *
 *   host-validation → origin-validation → request-ceiling → json-512kb →
 *   reject-batch → bearer (oauth) | header-identity (header) → inflight-limit →
 *   request-context → mcp-handler
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type McpHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { sanitizeErrorMessage } from './utils/sanitize.js';
import { createServerForRequest, type RequestContext, type UserContext } from './server.js';
import { UserRegistry, headerUserKey } from './services/user-registry.js';
import { InflightLimiter, RequestLifetime } from './services/inflight-limiter.js';
import { OUTBOUND_TIMEOUT_MS } from './services/outbound.js';
import type { HttpConfig } from './config/environment.js';
import { deprecatedSessionSettingsWarning } from './config/http/limits.js';
import { Encryptor } from './crypto.js';
import { createStorage } from './storage/index.js';
import { TokenHasher } from './auth/token-hash.js';
import type { GrantedScope, Storage } from './storage/types.js';
import { mountAuthorizationServer, type AuthorizationServer } from './auth/as-router.js';
import { YnabTokenResolver } from './auth/user-session.js';
import { deriveOriginsFromHosts, hostValidation, originValidation } from './middleware/origin-validation.js';
import {
  MAX_JSON_BODY,
  MAX_JSON_BODY_BYTES,
  mountRoute,
  mountStages,
  stage,
  type RoutePipeline,
  type Stage,
  type StageObserver,
} from './http/pipeline.js';
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

/** The MCP endpoint's path. */
const MCP_PATH = '/mcp';

/** Seconds a client is told to wait after a 429 from the in-flight caps (ADR-0001 Q5). */
export const INFLIGHT_RETRY_AFTER_SEC = 1;

/**
 * The provider's refusal text for a token (`verifyAccessToken`), reused for a
 * request-context failure so every 401 /mcp answers in oauth mode is the same:
 * a client can't tell a revoked YNAB grant from a bad token, and either way it
 * re-authorizes.
 */
const INVALID_ACCESS_TOKEN = 'Invalid or expired access token';

/** The header-mode refusal when no YNAB token is presented. */
const HEADER_TOKEN_MISSING = 'Unauthorized: provide a YNAB token via the X-YNAB-Token header';

/** The key of `AuthInfo.extra` the request-context stage puts the RequestContext under (ADR-0001 D3). */
const REQUEST_CONTEXT_KEY = 'ynabMcpRequestContext';

/**
 * How long before the request's deadline a tools/call handler gives up (and
 * returns its timeout result), so the result goes out before the ceiling cuts
 * the response: 1 s, or a tenth of a short ceiling.
 */
export function toolDeadlineMarginMs(requestTimeoutMs: number): number {
  return Math.min(1000, Math.floor(requestTimeoutMs / 10));
}

type JsonRpcId = string | number | null;

function jsonRpcError(code: number, message: string, id: JsonRpcId = null): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

/** The id to echo for a parsed JSON-RPC request body; null for anything else (a notification, a batch, no body). */
function echoableId(body: unknown): JsonRpcId {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { method, id } = body as { method?: unknown; id?: unknown };
  if (typeof method !== 'string') return null;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** Whether a stage must stop: the response has already been answered (a refusal, the ceiling) or is gone. */
function responseDone(res: Response): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

/**
 * Select and initialize the configured storage driver. A durable one gets the
 * token hasher, which its migration needs to check the pepper and hash 0.4.x
 * tokens (#52); it must be the instance the authorization server uses.
 */
async function buildStorage(config: HttpConfig, tokenKeys: TokenHasher): ReturnType<typeof createStorage> {
  switch (config.storageDriver) {
    case 'sqlite':
      if (!config.sqlitePath) throw new Error('SQLITE_PATH is required for the sqlite storage driver');
      return createStorage({ driver: 'sqlite', path: config.sqlitePath, tokenKeys });
    case 'postgres':
      if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the postgres storage driver');
      return createStorage({ driver: 'postgres', connectionString: config.databaseUrl, tokenKeys });
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

/** Who a request is from, as the caps key it: the user, and the client in oauth mode. */
interface Identity {
  readonly userKey: string;
  readonly clientId: string | undefined;
}

/** The app and what its owner starts and stops with it. */
export interface HttpApp {
  app: express.Express;
  /** The MCP handler; close() it once the HTTP server has stopped serving requests. */
  mcp: McpHttpHandler;
  /**
   * Resolves when every /mcp request is done: its response closed and the
   * work it started (a resolve, a tool call that outlived its response)
   * settled (D5). At once when none is in flight.
   */
  mcpDrained(): Promise<void>;
  /** The /mcp in-flight caps (ADR-0001 D6). */
  inflight: InflightLimiter;
  /** Per-user shared state; each /mcp request holds a lease while it runs (D5). */
  registry: UserRegistry;
  /** The extension jobs (src/http/extensions.ts): startHttpServer starts them; its close() stops them. */
  jobs: JobRunner;
  /**
   * The authorization server's routes and their stage names, in order,
   * starting with host-validation when that is on (oauth mode; undefined in
   * header mode). Asserted by tests/unit/http-as-pipeline.test.ts.
   */
  asPipeline: readonly RoutePipeline[] | undefined;
  /** /mcp's stage names, in order (ADR-0001). Asserted by tests/unit/http-mcp-pipeline.test.ts. */
  mcpPipeline: RoutePipeline;
}

/** Test hooks and overrides for buildHttpApp; production passes none. */
export interface HttpAppOptions {
  /** Replaces the registered route extensions. */
  routes?: readonly RouteExtension[];
  /** Replaces the registered job extensions. */
  jobs?: readonly JobExtension[];
  /** Reports each named stage as a request enters it. */
  observeStage?: StageObserver | undefined;
  /** The SDK's SSE keepalive interval (default 15 s), shortened by tests of a stream that times out. */
  mcpKeepAliveMs?: number;
}

/**
 * Build the Express app (async because oauth mode initializes storage).
 * Exported for testing without binding a port.
 */
export async function createHttpApp(config: HttpConfig, options: HttpAppOptions = {}): Promise<express.Express> {
  return (await buildHttpApp(config, options)).app;
}

/** Like createHttpApp, also returning what its owner starts and stops (the MCP handler, the jobs). */
export async function buildHttpApp(config: HttpConfig, options: HttpAppOptions = {}): Promise<HttpApp> {
  const app = express();
  // Number of reverse-proxy hops to trust for X-Forwarded-* (rate limiting, audit
  // logging). Defaults to 0 (trust none) so a self-hosted, direct-exposed instance
  // can't have its rate limit bypassed by a spoofed header; set TRUST_PROXY to the
  // hop count when running behind a known ingress (e.g. 1 behind a single Traefik).
  app.set('trust proxy', config.trustProxy);

  // Host/Origin validation (DNS rebinding + cross-site requests), the single
  // source of truth for these checks (the SDK's handler has none of its own).
  //  - Host is checked on every route except /health (probed by orchestrators
  //    by pod IP). That includes the OAuth endpoints and well-known metadata.
  //  - Origin is checked on /mcp only (its pipeline's origin-validation stage).
  //    The OAuth endpoints carry no ambient credentials (PKCE / client
  //    authentication) and the SDK serves them, and the well-known metadata,
  //    with permissive CORS on purpose so browser-based MCP clients can
  //    discover and register; /mcp is the credentialed, state-changing
  //    surface. The one cookie (the SameSite=Lax consent cookie the federation
  //    legs require) only proves which browser saw the consent page; it grants
  //    nothing by itself.
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
  }

  // oauth mode: storage, then the authorization server (src/auth/as-router.ts).
  // Each AS route carries its own bounded parser (and the /oauth legs their
  // limiter, ahead of it), so the AS is mounted before the global JSON parser.
  let storage: Storage | undefined;
  let oauth: { as: AuthorizationServer; resolver: YnabTokenResolver } | undefined;
  if (config.authMode === 'oauth') {
    // One hasher (TOKEN_PEPPER, else derived from ENCRYPTION_KEY) for storage's
    // migration and the provider's lookups, so the two can't use different peppers.
    const tokenHasher = TokenHasher.fromSecrets({
      tokenPepper: config.tokenPepper,
      encryptionKey: config.encryptionKey,
    });
    storage = await buildStorage(config, tokenHasher);
    const encryptor = new Encryptor(config.encryptionKey);
    const ynab = {
      clientId: config.oauthClientId as string,
      clientSecret: config.oauthClientSecret as string,
      // No YNAB call outlives the request ceiling (a refresh is shared by a
      // user's requests, so it is bounded by the setting, not one request's deadline).
      timeoutMs: Math.min(OUTBOUND_TIMEOUT_MS, config.requestTimeoutMs),
    };
    oauth = {
      as: mountAuthorizationServer(app, {
        config,
        storage,
        encryptor,
        tokenHasher,
        ynab,
        observeStage: options.observeStage,
      }),
      resolver: new YnabTokenResolver(storage, encryptor, ynab),
    };
  }
  const asPipeline = oauth?.as.routes.map((r) => ({ route: r.route, stages: [...upstreamStages, ...r.stages] }));

  const registry = new UserRegistry({
    rateLimitPerHour: config.rateLimitPerHour,
    rateLimitMaxWaitMs: config.rateLimitMaxWaitMs,
    cacheTtlMs: config.cacheTtlMs,
  });
  const inflight = new InflightLimiter({
    perUser: config.maxInflightPerUser,
    perClient: config.maxInflightPerClient,
    total: config.maxInflight,
  });

  // ---- /mcp ------------------------------------------------------------------

  // Each request's lifetime (D5), from request-ceiling on.
  const lifetimes = new WeakMap<Request, RequestLifetime>();
  // Contexts built by request-context; the factory accepts nothing else.
  const issuedContexts = new WeakSet<RequestContext>();
  // /mcp requests not yet released (D5), so shutdown can wait for them,
  // including a timed-out tool call's YNAB work (mcpDrained).
  let liveRequests = 0;
  let drainWaiters: Array<() => void> = [];

  /**
   * Refuse a request's credentials: in oauth mode the same 401 the bearer
   * stage gives an invalid token (challenge with resource_metadata, OAuth
   * error body; gate G6), in header mode a JSON-RPC error.
   */
  const refuseCredentials = (res: Response): void => {
    if (oauth) {
      // RFC 9728 metadata URL in the challenge, as the bearer stage sends it.
      const error = new OAuthError(OAuthErrorCode.InvalidToken, INVALID_ACCESS_TOKEN);
      const challenge = bearerAuthChallengeResponse(error, { resourceMetadataUrl: oauth.as.resourceMetadataUrl }).headers.get(
        'WWW-Authenticate'
      );
      if (challenge !== null) res.set('WWW-Authenticate', challenge);
      res.status(401).json(error.toResponseObject());
      return;
    }
    res.status(401).json(jsonRpcError(-32001, HEADER_TOKEN_MISSING));
  };

  /** The request's lifetime; request-ceiling always set it before any stage that asks. */
  const lifetimeOf = (req: Request): RequestLifetime => {
    const lifetime = lifetimes.get(req);
    if (!lifetime) throw new Error('/mcp stage ran without request-ceiling');
    return lifetime;
  };

  /** Run `handler` only while the request is still live; a closed or answered one is dropped. */
  const live =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) => {
      if (responseDone(res) || lifetimeOf(req).isClosed) return undefined;
      return handler(req, res, next);
    };

  /** The identity the auth stage established (bearer in oauth mode, header-identity in header mode). */
  const identityOf = (req: Request): Identity | undefined => {
    const auth = req.auth;
    if (auth === undefined) return undefined;
    if (oauth) {
      const userId = auth.extra?.['userId'];
      return typeof userId === 'string' ? { userKey: userId, clientId: auth.clientId } : undefined;
    }
    // Header mode has no client identity; only the per-user cap applies (D6).
    return { userKey: auth.token, clientId: undefined };
  };

  /**
   * The ceiling (D6): a request still running MCP_REQUEST_TIMEOUT_MS after
   * request-ceiling started is ended. One whose response hasn't started gets
   * a JSON-RPC error echoing its id ("Request timed out"; id null, 408 and
   * Connection: close when its body hasn't fully arrived). One already
   * streaming (the 2025 SSE leg) has its stream ended: a tools/call there has
   * already had its timeout result from the handler's own, earlier deadline.
   */
  const onCeiling = (req: Request, res: Response): void => {
    if (res.writableEnded || res.destroyed) return;
    console.error('[Request] /mcp request reached MCP_REQUEST_TIMEOUT_MS; ending it');
    // The SDK may still write to this response; past its end that is an
    // 'error' event, which must not go unhandled.
    res.on('error', () => undefined);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (!req.complete) {
      res.set('Connection', 'close');
      res.status(408).json(jsonRpcError(-32000, 'Request timed out'));
      return;
    }
    res.status(504).json(jsonRpcError(-32000, 'Request timed out', echoableId(req.body)));
  };

  const requestCeiling: RequestHandler = (req, res, next) => {
    const lifetime = new RequestLifetime(Date.now() + config.requestTimeoutMs);
    lifetimes.set(req, lifetime);
    // The first hold, so released last: once the slot and lease are back.
    liveRequests++;
    lifetime.hold(() => {
      liveRequests--;
      if (liveRequests === 0) {
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
    const timer = setTimeout(() => onCeiling(req, res), config.requestTimeoutMs);
    res.once('close', () => {
      clearTimeout(timer);
      lifetime.close();
    });
    next();
  };

  // MCP 2025-06-18+ removed JSON-RPC batching; reject arrays outright.
  const rejectBatch: RequestHandler = (req, res, next) => {
    if (Array.isArray(req.body)) {
      res.status(400).json(jsonRpcError(-32600, 'Invalid Request: JSON-RPC batching is not supported'));
      return;
    }
    next();
  };

  // Header mode: the effective YNAB token is the request's identity. req.auth
  // carries its digest, never the token (D3).
  const effectiveToken = (req: Request): string | undefined =>
    (req.header('x-ynab-token') ?? config.fallbackAccessToken) || undefined;
  const headerIdentity: RequestHandler = (req, res, next) => {
    const token = effectiveToken(req);
    if (!token) {
      refuseCredentials(res);
      return;
    }
    req.auth = { token: headerUserKey(token), clientId: 'header', scopes: [] };
    next();
  };

  const inflightLimit: RequestHandler = (req, res, next) => {
    const identity = identityOf(req);
    if (identity === undefined) {
      refuseCredentials(res);
      return;
    }
    const slot = inflight.acquire(identity.userKey, identity.clientId);
    if (typeof slot === 'string') {
      res.set('Retry-After', String(INFLIGHT_RETRY_AFTER_SEC));
      res.status(429).json(jsonRpcError(-32000, 'Too many requests in flight; retry shortly', echoableId(req.body)));
      return;
    }
    if (!lifetimeOf(req).hold(() => slot.release())) return;
    next();
  };

  /**
   * The user settings for this request, or why there are none: `refused`
   * (answer 401) or `ended` (the response closed meanwhile; answer nothing).
   */
  const resolveUser = async (
    req: Request,
    identity: Identity,
    lifetime: RequestLifetime
  ): Promise<{ user: UserContext } | 'refused' | 'ended'> => {
    const limits = {
      defaultBudgetId: config.defaultBudgetId,
      rateLimitPerHour: config.rateLimitPerHour,
      rateLimitMaxWaitMs: config.rateLimitMaxWaitMs,
      cacheTtlMs: config.cacheTtlMs,
    };
    if (!oauth) {
      const token = effectiveToken(req);
      if (!token) return 'refused';
      return { user: { ...limits, accessToken: token, readOnly: config.readOnly } };
    }
    const { resolver } = oauth;
    const userId = identity.userKey;
    // The grant can change between requests (a downgrade, a revoked YNAB
    // grant): resolved on every request, a started step of the request (D5).
    const pending = lifetime.run(() => resolver.resolve(userId));
    if (pending === undefined) return 'ended';
    let grantedScope: GrantedScope;
    let generation: number;
    try {
      ({ grantedScope, generation } = await pending);
    } catch {
      return 'refused';
    }
    const auth = req.auth;
    // Write access needs all of: writes enabled globally (YNAB_READ_ONLY off
    // and YNAB_OAUTH_ALLOW_WRITE on, checked here on every request and not
    // only at consent, so a read-write grant from before the operator turned
    // writes off cannot write), a read-write grant on this token (per client grant, not the user's latest consent), and
    // a read-write YNAB token for the user (YNAB enforces that one anyway).
    const tokenScope = auth === undefined ? 'read-only' : tokenAccessLevel(auth);
    return {
      user: {
        ...limits,
        // Pinned to the account generation resolved here.
        accessToken: resolver.accessTokenFor(userId, generation),
        readOnly:
          config.readOnly || !config.allowWrite || tokenScope === 'read-only' || grantedScope === 'read-only',
      },
    };
  };

  const toolMarginMs = toolDeadlineMarginMs(config.requestTimeoutMs);
  const requestContext: RequestHandler = async (req, res, next) => {
    const lifetime = lifetimeOf(req);
    const identity = identityOf(req);
    if (identity === undefined) {
      refuseCredentials(res);
      return;
    }
    const resolved = await resolveUser(req, identity, lifetime);
    if (resolved === 'ended' || responseDone(res) || lifetime.isClosed) return;
    if (resolved === 'refused') {
      refuseCredentials(res);
      return;
    }
    const lease = registry.acquire(identity.userKey);
    if (!lifetime.hold(() => lease.release())) return;
    const ctx: RequestContext = Object.freeze({
      requestId: randomUUID(),
      userKey: identity.userKey,
      clientId: identity.clientId,
      user: resolved.user,
      components: lease.components,
      toolCalls: Object.freeze({
        deadline: lifetime.deadline - toolMarginMs,
        run: <T>(work: () => Promise<T>) => lifetime.run(work),
      }),
    });
    issuedContexts.add(ctx);
    const auth = req.auth as AuthInfo;
    req.auth = { ...auth, extra: { ...auth.extra, [REQUEST_CONTEXT_KEY]: ctx } };
    next();
  };

  // The factory only builds: everything that can fail ran in the stages
  // above, and a throwing factory is a generic 500 inside the SDK (D3).
  const factory: McpServerFactory = ({ authInfo }) => {
    const ctx = authInfo?.extra?.[REQUEST_CONTEXT_KEY] as RequestContext | undefined;
    if (ctx === undefined || !issuedContexts.has(ctx)) {
      throw new Error('/mcp factory called without a request context');
    }
    return createServerForRequest(ctx);
  };
  // Detailed SDK errors (a failed factory, a refused protocol version) are
  // logged internally only; the SDK's responses carry no internals.
  const reportMcpError = (error: Error): void => {
    console.error('[HttpError]', sanitizeErrorMessage(error));
  };
  const mcp = createMcpHandler(factory, {
    // Already the SDK default; explicit so a default change can't switch us to 'reject' (D1).
    legacy: 'stateless',
    maxRequestBodySize: MAX_JSON_BODY_BYTES,
    onerror: reportMcpError,
    ...(options.mcpKeepAliveMs !== undefined ? { keepAliveMs: options.mcpKeepAliveMs } : {}),
  });
  const nodeHandler = toNodeHandler(mcp, { maxRequestBodySize: MAX_JSON_BODY_BYTES, onerror: reportMcpError });
  // toNodeHandler ignores Express's `next`; the body express.json parsed is passed explicitly.
  const mcpHandler: RequestHandler = (req, res) => nodeHandler(req, res, req.body as unknown);

  const mcpStages: Stage[] = [];
  if (config.enableDnsRebindingProtection) {
    const hosts = config.allowedHosts ?? [];
    mcpStages.push(stage('origin-validation', originValidation(config.allowedOrigins ?? deriveOriginsFromHosts(hosts))));
  }
  mcpStages.push(
    stage('request-ceiling', requestCeiling),
    // Inside the ceiling, so a slow upload hits the deadline (D12).
    stage('json-512kb', live(express.json({ limit: MAX_JSON_BODY }))),
    stage('reject-batch', live(rejectBatch)),
    oauth
      ? stage(
          'bearer',
          // v2's middleware answers 401 with the challenge only for v2's
          // OAuthError: the provider throws that for every refused token
          // (ADR-0001 D14). expectedResource makes the SDK refuse (401
          // invalid_token) any token whose audience is not this resource; the
          // provider also checks it, and reports 0.3.x tokens as bound to it.
          live(
            requireBearerAuth({
              verifier: oauth.as.provider,
              resourceMetadataUrl: oauth.as.resourceMetadataUrl,
              expectedResource: oauth.as.resourceServerUrl,
            })
          )
        )
      : stage('header-identity', live(headerIdentity)),
    // Before request-context, so a refused request costs no storage read.
    stage('inflight-limit', live(inflightLimit)),
    stage('request-context', live(requestContext)),
    stage('mcp-handler', live(mcpHandler))
  );
  // Exactly /mcp, every method: GET and DELETE reach the SDK, which answers 405 (D1).
  const mcpPipeline: RoutePipeline = {
    route: MCP_PATH,
    stages: [...upstreamStages, ...mountRoute(app, MCP_PATH, mcpStages, options.observeStage)],
  };

  // ---- everything else -------------------------------------------------------

  // Every other route's JSON body; /mcp has its own parser inside its ceiling.
  app.use(express.json({ limit: MAX_JSON_BODY }));

  app.get('/health', (_req: Request, res: Response) => {
    // Unauthenticated: reveals nothing about the mode or the load (D10).
    res.json({ status: 'ok' });
  });

  // Extension routes (src/http/extensions.ts): after host validation, the AS
  // and the JSON parser. Unauthenticated, so they never see a request for /mcp
  // or under it.
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

  // Body-parser failures -> JSON-RPC-shaped errors, with no stack traces or internal text.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // Already answered (the request ceiling): nothing more to send.
      if (res.writableEnded) return;
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

  const mcpDrained = (): Promise<void> =>
    liveRequests === 0 ? Promise.resolve() : new Promise<void>((resolve) => drainWaiters.push(resolve));

  return { app, mcp, mcpDrained, inflight, registry, jobs, asPipeline, mcpPipeline };
}

/**
 * Build and start the HTTP server. Returns the Node http.Server; closing it
 * stops accepting connections, lets the /mcp requests in flight finish with
 * the work they started (the process entry's shutdown deadline bounds the
 * wait), then closes the MCP handler and stops the extension jobs, which
 * start here once storage is ready.
 */
export async function startHttpServer(
  config: HttpConfig,
  options: HttpAppOptions = {}
): Promise<ReturnType<express.Express['listen']>> {
  const { app, mcp, mcpDrained, jobs } = await buildHttpApp(config, options);
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
    const deprecated = deprecatedSessionSettingsWarning(config.deprecatedSessionSettings);
    if (deprecated !== undefined) console.error(deprecated);
  };
  const httpServer =
    config.bindHost === undefined ? app.listen(config.port, onListening) : app.listen(config.port, config.bindHost, onListening);
  const closeServer = httpServer.close.bind(httpServer);
  httpServer.close = (callback) => {
    // In-flight /mcp requests finish first, including work that outlived its
    // response (a timed-out tool call's YNAB write and its audit entry), so a
    // caller that exits the process from the callback (index.ts) doesn't cut
    // it off. Their keep-alive connections are then idle and would hold
    // close() open until they time out, so they are closed once the last
    // request is done. The callback also waits for the jobs: a job's stop()
    // may be async (finishing a sweep, releasing a lock).
    const drained = mcpDrained().then(() => {
      setImmediate(() => httpServer.closeIdleConnections());
    });
    const stopped = Promise.allSettled([drained.then(() => mcp.close()), jobs.stop()]);
    return closeServer((err) => {
      void stopped.then(() => callback?.(err));
    });
  };
  return httpServer;
}
