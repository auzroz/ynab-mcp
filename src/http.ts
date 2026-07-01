/**
 * HTTP (remote) transport for the YNAB MCP server.
 *
 * Exposes the MCP Streamable HTTP transport over Express with **per-session**
 * server instances — each session gets its own YnabClient / cache / rate limiter /
 * audit log, so nothing leaks between concurrent clients.
 *
 * PHASE 1 (interim auth): the YNAB access token is supplied per session via the
 * `X-YNAB-Token` header (falling back to the `YNAB_ACCESS_TOKEN` env for
 * single-user HTTP). This is a stopgap to validate the transport/data plane and
 * MUST be used only over TLS; it is replaced by the YNAB-OAuth flow in a later
 * phase.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServerForUser } from './server.js';
import type { HttpConfig } from './config/environment.js';

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * Build the Express app (exported for testing without binding a port).
 */
export function createHttpApp(config: HttpConfig): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Active sessions: session id -> transport. Each transport is wired to its own
  // per-user MCP Server instance.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Plain HTTP health check for load balancers / reverse proxies.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', sessions: transports.size });
  });

  // Client -> server messages (and streamed responses).
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      // Only a fresh `initialize` (with no session id) may open a new session.
      if (sessionId !== undefined || !isInitializeRequest(req.body)) {
        res
          .status(400)
          .json(jsonRpcError(-32000, 'Bad Request: no valid session for this request'));
        return;
      }

      // Bind this session to a YNAB token (interim: header, else env fallback).
      const token = req.header('x-ynab-token') ?? config.fallbackAccessToken;
      if (!token) {
        res
          .status(401)
          .json(jsonRpcError(-32001, 'Unauthorized: provide a YNAB token via the X-YNAB-Token header'));
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

      const server = createServerForUser({
        accessToken: token,
        defaultBudgetId: config.defaultBudgetId,
        readOnly: config.readOnly,
        rateLimitPerHour: config.rateLimitPerHour,
        cacheTtlMs: config.cacheTtlMs,
      });
      // Cast bridges an exactOptionalPropertyTypes mismatch between the SDK's
      // Transport interface (optional onclose) and the transport's accessor type.
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
    await transport.handleRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse
    );
  };
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  return app;
}

/**
 * Build and start the HTTP server. Returns the Node http.Server.
 */
export function startHttpServer(config: HttpConfig): ReturnType<express.Express['listen']> {
  const app = createHttpApp(config);
  const httpServer = app.listen(config.port, () => {
    console.error(`YNAB MCP Server (HTTP) listening on port ${config.port}`);
    console.error(
      config.readOnly
        ? 'READ-ONLY mode (write operations disabled)'
        : 'WRITE operations ENABLED'
    );
    console.error(
      'Interim auth: YNAB token via X-YNAB-Token header (TLS required; replaced by OAuth in a later phase)'
    );
  });
  return httpServer;
}
