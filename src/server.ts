/**
 * MCP Server Configuration and Tool Registration
 */

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config/environment.js';

// Read the version from package.json at runtime so the server always advertises
// the published version. Resolved relative to this module, package.json sits at
// the project root in both dev (src/) and the compiled build (dist/).
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import { YnabClient, type AccessTokenSource } from './services/ynab-client.js';
import { createUserComponents, type UserComponents } from './services/user-registry.js';
import { tools, handleToolCall } from './tools/index.js';
import {
  prompts,
  getPromptMessages,
  sanitizePromptName,
  UnknownPromptError,
  InvalidPromptArgumentsError,
} from './prompts/index.js';
import { sanitizeErrorMessage } from './utils/sanitize.js';
import { formatErrorResponse, ReadOnlyModeError } from './utils/errors.js';
import { assertSafeToolInput } from './utils/input-guard.js';

/**
 * Per-session context for building a server instance. In multi-tenant (HTTP)
 * mode one is built per MCP session; the session's user supplies the shared
 * components (see UserRegistry), so nothing is shared between users.
 */
export interface UserContext {
  /** A fixed token (stdio, header mode) or a per-request resolver (oauth mode). */
  accessToken: AccessTokenSource;
  defaultBudgetId?: string | undefined;
  readOnly: boolean;
  rateLimitPerHour: number;
  cacheTtlMs: number;
}

/**
 * Build a session's YnabClient on the given per-user components (rate limiter,
 * cache, audit log). Without them it gets its own set (stdio, tests).
 */
export function buildYnabClient(
  ctx: UserContext,
  components: UserComponents = createUserComponents(ctx)
): YnabClient {
  return new YnabClient(
    ctx.accessToken,
    ctx.defaultBudgetId,
    components.rateLimiter,
    components.cache,
    ctx.readOnly,
    components.auditLog
  );
}

/**
 * Create an MCP `Server` that dispatches tool calls to the given YnabClient.
 * Shared by the stdio (single-user) and HTTP (per-user) entrypoints.
 */
export function createServerFromClient(ynabClient: YnabClient): Server {
  const server = new Server(
    {
      name: 'ynab-mcp',
      version: pkg.version,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  const writeToolNames = new Set(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Hide write tools from read-only sessions. This is a UX nicety only: the
    // YnabClient write guard still rejects writes server-side. Uses the
    // per-client value so each HTTP session gets its own list.
    if (ynabClient.isReadOnly()) {
      return { tools: tools.filter((t) => t.annotations?.readOnlyHint === true) };
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Reject oversized/deeply nested arguments before any zod parsing
      // (defense in depth against resource exhaustion).
      assertSafeToolInput(args ?? {});
      // A tool hidden from a read-only session's list is rejected here too, so
      // calling it by name gets the same read-only error even when its handler
      // would not reach the client's write guard (the deprecated no-op import).
      if (ynabClient.isReadOnly() && writeToolNames.has(name)) {
        throw new ReadOnlyModeError(name);
      }
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

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      return getPromptMessages(name, args ?? {});
    } catch (error) {
      // Client errors map to InvalidParams with a sanitized name only.
      if (error instanceof UnknownPromptError) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${sanitizePromptName(name)}`);
      }
      if (error instanceof InvalidPromptArgumentsError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for prompt ${sanitizePromptName(name)}: ${error.message}`
        );
      }
      // Anything else is ours. Log the detail server-side and return a generic
      // message, because the SDK forwards plain Error text to the client.
      console.error('[PromptError]', sanitizeErrorMessage(error));
      throw new McpError(ErrorCode.InternalError, 'Failed to build prompt');
    }
  });

  return server;
}

/**
 * Build a per-session MCP server (multi-tenant / HTTP mode), on the user's
 * shared components when given.
 */
export function createServerForUser(ctx: UserContext, components?: UserComponents): Server {
  return createServerFromClient(buildYnabClient(ctx, components));
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
