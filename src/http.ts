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
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createServerForUser, type UserContext } from './server.js';
import type { HttpConfig } from './config/environment.js';
import { Encryptor } from './crypto.js';
import { createStorage } from './storage/index.js';
import { McpOAuthProvider } from './auth/mcp-provider.js';
import { YnabTokenResolver } from './auth/user-session.js';

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
  app.use(express.json({ limit: '4mb' }));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', authMode: config.authMode, sessions: transports.size });
  });

  // Resolves the per-session UserContext at `initialize` time.
  let resolveInitContext: (req: Request) => Promise<ContextResult>;

  if (config.authMode === 'oauth') {
    // --- OAuth mode: AS endpoints + YNAB federation ---
    const storage = await buildStorage(config);
    const encryptor = new Encryptor(config.encryptionKey);
    const ynab = {
      clientId: config.oauthClientId as string,
      clientSecret: config.oauthClientSecret as string,
    };
    const publicUrl = config.publicUrl as string;
    const provider = new McpOAuthProvider({
      storage,
      encryptor,
      ynab,
      publicUrl,
      allowWrite: config.allowWrite,
      globalReadOnly: config.readOnly,
      accessTokenTtlSec: config.accessTokenTtlSec,
      authCodeTtlSec: config.authCodeTtlSec,
    });
    const resolver = new YnabTokenResolver(storage, encryptor, ynab);

    // OAuth 2.1 AS endpoints (/authorize, /token, /register, /revoke, metadata).
    app.use(mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl) }));

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

    // Protect the MCP endpoint with the bearer verifier.
    app.use('/mcp', requireBearerAuth({ verifier: provider }));

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
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId !== undefined || !isInitializeRequest(req.body)) {
        res.status(400).json(jsonRpcError(-32000, 'Bad Request: no valid session for this request'));
        return;
      }

      const result = await resolveInitContext(req);
      if (!result.ok) {
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
