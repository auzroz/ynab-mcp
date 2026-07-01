/**
 * MCP Server Configuration and Tool Registration
 */

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config/environment.js';

// Read the version from package.json at runtime so the server always advertises
// the published version. Resolved relative to this module, package.json sits at
// the project root in both dev (src/) and the compiled build (dist/).
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import { YnabClient } from './services/ynab-client.js';
import { RateLimiter } from './services/rate-limiter.js';
import { Cache } from './services/cache.js';
import { AuditLog } from './services/audit-log.js';
import { tools, handleToolCall } from './tools/index.js';
import { formatErrorResponse } from './utils/errors.js';

/**
 * Per-user context for building an isolated server instance. In multi-tenant
 * (HTTP) mode one of these is built per authenticated user so each gets its own
 * YNAB client, cache, rate limiter, and audit log — no cross-user leakage.
 */
export interface UserContext {
  accessToken: string;
  defaultBudgetId?: string | undefined;
  readOnly: boolean;
  rateLimitPerHour: number;
  cacheTtlMs: number;
}

/**
 * Build a fully-isolated YnabClient (own rate limiter, cache, and audit log).
 */
export function buildYnabClient(ctx: UserContext): YnabClient {
  const rateLimiter = new RateLimiter(ctx.rateLimitPerHour);
  const cache = new Cache(ctx.cacheTtlMs);
  const auditLog = new AuditLog();
  return new YnabClient(
    ctx.accessToken,
    ctx.defaultBudgetId,
    rateLimiter,
    cache,
    ctx.readOnly,
    auditLog
  );
}

/**
 * Create an MCP `Server` that dispatches tool calls to the given YnabClient.
 * Shared by the stdio (single-user) and HTTP (per-user) entrypoints.
 */
export function createServerFromClient(ynabClient: YnabClient): Server {
  const server = new Server(
    {
      name: 'ynab-mcp-server',
      version: pkg.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(name, args ?? {}, ynabClient);
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatErrorResponse(error) }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Build a per-user MCP server (multi-tenant / HTTP mode).
 */
export function createServerForUser(ctx: UserContext): Server {
  return createServerFromClient(buildYnabClient(ctx));
}

/**
 * Create the single-user server from process config (stdio mode).
 */
export function createServer(config: Config): Server {
  if (config.readOnly) {
    console.error('YNAB MCP Server running in READ-ONLY mode (write operations disabled)');
  } else {
    console.error('YNAB MCP Server running with WRITE operations ENABLED');
  }

  return createServerForUser({
    accessToken: config.accessToken,
    defaultBudgetId: config.defaultBudgetId,
    readOnly: config.readOnly,
    rateLimitPerHour: config.rateLimitPerHour,
    cacheTtlMs: config.cacheTtlMs,
  });
}
