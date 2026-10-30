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
 * In both modes each MCP session gets its own YnabClient / cache / rate limiter /
 * audit log — nothing leaks between users.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import type { HttpConfig } from './config/environment.js';
import { Encryptor } from './crypto.js';
import { createStorage } from './storage/index.js';
import { McpOAuthProvider } from './auth/mcp-provider.js';
import { YnabTokenResolver } from './auth/user-session.js';
import { issOnAuthorizationRedirects } from './middleware/iss-redirect.js';

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

/** Result of resolving a session's user context, or an HTTP error to return. */
type ContextResult =
  | { ok: true; ctx: UserContext }
  | { ok: false; status: number; message: string };

/**
 * Build the Express app (async because oauth mode initializes storage).
 * Exported for testing without binding a port.
 */
export async function createHttpApp(config: HttpConfig): Promise<express.Express> {
  const app = express();
  // Number of reverse-proxy hops to trust for X-Forwarded-* (rate limiting, audit
  // logging). Defaults to 0 (trust none) so a self-hosted, direct-exposed instance
  // can't have its rate limit bypassed by a spoofed header; set TRUST_PROXY to the
  // hop count when running behind a known ingress (e.g. 1 behind a single Traefik).
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: MAX_JSON_BODY }));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', authMode: config.authMode, sessions: transports.size });
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

    // YNAB federation legs.
    app.get('/oauth/ynab/start', async (req: Request, res: Response) => {
      try {
        const state = String(req.query['state'] ?? '');
        const scope = req.query['scope'] === 'read-write' ? 'read-write' : 'read-only';
        const url = await provider.startYnabAuthorization(state, scope);
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
          res.redirect(await provider.denyAuthorization(state, denial));
          return;
        }
        if (!code || !state) {
          res.status(400).send('Missing code or state.');
          return;
        }
        const redirect = await provider.handleYnabCallback(code, state);
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
        res.redirect(await provider.denyAuthorization(state, 'access_denied'));
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

    resolveInitContext = async (req: Request): Promise<ContextResult> => {
      const auth = (req as unknown as { auth?: AuthInfo }).auth;
      const userId = auth?.extra?.['userId'];
      if (typeof userId !== 'string') {
        return { ok: false, status: 401, message: 'Unauthorized: token missing user identity' };
      }
      try {
        const { accessToken, grantedScope } = await resolver.resolve(userId);
        return {
          ok: true,
          ctx: {
            accessToken,
            defaultBudgetId: config.defaultBudgetId,
            readOnly: config.readOnly || grantedScope === 'read-only',
            rateLimitPerHour: config.rateLimitPerHour,
            cacheTtlMs: config.cacheTtlMs,
          },
        };
      } catch {
        return { ok: false, status: 401, message: 'Unauthorized: could not resolve YNAB access — re-authorize' };
      }
    };
  } else {
    // --- Interim header mode ---
    resolveInitContext = async (req: Request): Promise<ContextResult> => {
      const token = req.header('x-ynab-token') ?? config.fallbackAccessToken;
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
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId !== undefined || !isInitializeRequest(req.body)) {
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

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: config.enableDnsRebindingProtection,
        ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
        ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, newTransport);
        },
      });
      newTransport.onclose = () => {
        const sid = newTransport.sessionId;
        if (sid) transports.delete(sid);
      };

      const server = createServerForUser(result.ctx);
      await server.connect(newTransport as unknown as Parameters<typeof server.connect>[0]);
      transport = newTransport;
    }

    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      req.body
    );
  });

  // Server -> client stream (GET) and explicit session teardown (DELETE).
  const sessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json(jsonRpcError(-32000, 'Bad Request: unknown or missing session id'));
      return;
    }
    await transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
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

  return app;
}

/**
 * Build and start the HTTP server. Returns the Node http.Server.
 */
export async function startHttpServer(
  config: HttpConfig
): Promise<ReturnType<express.Express['listen']>> {
  const app = await createHttpApp(config);
  const httpServer = app.listen(config.port, () => {
    console.error(`YNAB MCP Server (HTTP, ${config.authMode} auth) listening on port ${config.port}`);
    console.error(
      config.readOnly ? 'READ-ONLY mode (write operations disabled)' : 'WRITE operations ENABLED'
    );
    if (config.authMode === 'header') {
      console.error(
        'Interim auth: YNAB token via X-YNAB-Token header (TLS required; set the YNAB OAuth env vars to enable OAuth)'
      );
    }
  });
  return httpServer;
}
