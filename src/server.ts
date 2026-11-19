/**
 * MCP Server Configuration and Tool Registration
 */

import { createRequire } from 'node:module';
import { Server, ProtocolError, ProtocolErrorCode, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Config } from './config/environment.js';

// Read the version from package.json at runtime so the server always advertises
// the published version. Resolved relative to this module, package.json sits at
// the project root in both dev (src/) and the compiled build (dist/).
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
import { YnabClient, type AccessTokenSource } from './services/ynab-client.js';
import { createUserComponents, type UserComponents } from './services/user-registry.js';
import { tools, handleToolCall } from './tools/index.js';
import { UNTRUSTED_TEXT_NOTE } from './tools/untrusted-note.js';
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
 * The user-facing settings a YnabClient is built with. In multi-tenant (HTTP)
 * mode one is computed per request (its read-only flag included, ADR-0001
 * D4); the request's user supplies the shared components (see UserRegistry),
 * so nothing is shared between users.
 */
export interface UserContext {
  /** A fixed token (stdio, header mode) or a per-request resolver (oauth mode). */
  accessToken: AccessTokenSource;
  defaultBudgetId?: string | undefined;
  readOnly: boolean;
  rateLimitPerHour: number;
  /** Longest wait for a rate-limit token in ms (default 2000; 0 = never wait). */
  rateLimitMaxWaitMs?: number | undefined;
  cacheTtlMs: number;
}

/**
 * How a tools/call runs inside one HTTP request (ADR-0001 D5, D6). Absent on
 * stdio, where a call runs unbounded as before.
 */
export interface ToolCallBounds {
  /**
   * Absolute time (epoch ms) by which the handler returns, finished or not:
   * the request's own deadline less a margin, so a slow stage before the
   * handler shortens the call instead of pushing it past the request ceiling.
   */
  readonly deadline: number;
  /**
   * Start the call as part of the request, which keeps its in-flight slot and
   * registry lease until the call settles, even after the response has gone.
   * Undefined, without starting it, once the request has ended.
   */
  run<T>(work: () => Promise<T>): Promise<T> | undefined;
}

/**
 * Everything one /mcp request's server is built from, resolved before the
 * factory runs (ADR-0001 D3): identity, read-only state, the user's shared
 * components and the request's bounds. Our own type, carried to the factory
 * under one key of `AuthInfo.extra`; not the SDK's McpRequestContext.
 */
export interface RequestContext {
  /** Unique per request (for logs and #60's audit context). */
  readonly requestId: string;
  /** The user's registry key: the YNAB user id (oauth), or the YNAB token's digest (header). */
  readonly userKey: string;
  /** The authenticated MCP client (oauth mode); undefined in header mode. */
  readonly clientId: string | undefined;
  /** The settings this request's YnabClient is built with, its read-only flag computed for this request. */
  readonly user: UserContext;
  /** The user's components, held by this request's registry lease. */
  readonly components: UserComponents;
  readonly toolCalls: ToolCallBounds;
}

/**
 * Build a YnabClient on the given per-user components (rate limiter, cache,
 * delta snapshots, audit log, feed state). Without them it gets its own set
 * (stdio, tests).
 */
export function buildYnabClient(
  ctx: UserContext,
  components: UserComponents = createUserComponents(ctx),
  // The request's absolute deadline (HTTP): no YNAB call outlives it (#58).
  deadline?: number
): YnabClient {
  return new YnabClient(
    ctx.accessToken,
    ctx.defaultBudgetId,
    components.rateLimiter,
    components.cache,
    ctx.readOnly,
    components.auditLog,
    components.deltaCache,
    components.feedState,
    { breaker: components.breaker, deadline }
  );
}

/** What a tools/call that hit its deadline says; never "failed" for a write that may have run (ADR-0001 D6). */
export const TOOL_TIMEOUT_MESSAGE = 'Request timed out';
export const WRITE_TIMEOUT_MESSAGE =
  'Request timed out; the change may still have been applied. Check (for example with ynab_list_transactions) before retrying';

function toolTimeoutResult(outcomeUnknown: boolean): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const body = outcomeUnknown
    ? {
        error: true,
        type: 'request_timeout',
        message: WRITE_TIMEOUT_MESSAGE,
        outcome: 'unknown',
        suggestion: 'Check whether the change was applied before retrying it.',
      }
    : { error: true, type: 'request_timeout', message: TOOL_TIMEOUT_MESSAGE, suggestion: 'Try again shortly.' };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

/**
 * Run `work` within `bounds`: its value, or `undefined` with whether it
 * started when the deadline came first (or the request had already ended, in
 * which case it never starts). A rejection of `work` before the deadline is
 * rethrown; one after it is left to the request's settle hook.
 */
async function runWithin<T>(
  bounds: ToolCallBounds,
  work: () => Promise<T>
): Promise<{ done: true; value: T } | { done: false; started: boolean }> {
  const remaining = bounds.deadline - Date.now();
  if (remaining <= 0) return { done: false, started: false };
  const started = bounds.run(work);
  if (started === undefined) return { done: false, started: false };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ done: false; started: true }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false, started: true }), remaining);
  });
  try {
    return await Promise.race([started.then((value) => ({ done: true as const, value })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Advertised as serverInfo.description; says what the server is and holds no user data. */
export const SERVER_DESCRIPTION =
  'MCP server for the YNAB (You Need A Budget) API: budgets, accounts, categories, payees, transactions, scheduled transactions, and spending analytics.';

/**
 * Create an MCP `Server` that dispatches tool calls to the given YnabClient.
 * Shared by the stdio (single-user) and HTTP (per-request) entrypoints; HTTP
 * passes the request's tool-call bounds.
 */
export function createServerFromClient(ynabClient: YnabClient, toolCalls?: ToolCallBounds): Server {
  const server = new Server(
    {
      name: 'ynab-mcp',
      version: pkg.version,
      description: SERVER_DESCRIPTION,
    },
    {
      // No `listChanged` and no subscriptions: the tool and prompt lists are
      // fixed for the life of a server instance (ADR-0001 D13).
      capabilities: {
        tools: {},
        prompts: {},
      },
      // 2026-07-28 caching of tools/list, set explicitly rather than left to
      // the SDK default: the list depends on the caller's read-only state, so
      // it is never shared-cacheable (ADR-0001 D11). Ignored on 2025-era connections.
      cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } },
      // Covers every tool result, including the many read tools that return
      // only names and so carry no per-tool note (#61b).
      instructions: UNTRUSTED_TEXT_NOTE,
    }
  );

  const writeToolNames = new Set(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name));

  server.setRequestHandler('tools/list', async () => {
    // Hide write tools from read-only callers. This is a UX nicety only: the
    // YnabClient write guard still rejects writes server-side. Uses the
    // per-client value, computed per HTTP request (ADR-0001 D4).
    if (ynabClient.isReadOnly()) {
      return { tools: tools.filter((t) => t.annotations?.readOnlyHint === true) };
    }
    return { tools };
  });

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Reject oversized/deeply nested arguments before any zod parsing
      // (defense in depth against resource exhaustion).
      assertSafeToolInput(args ?? {});
      // A tool hidden from a read-only caller's list is rejected here too, so
      // calling it by name gets the same read-only error even when its handler
      // would not reach the client's write guard (the deprecated no-op import).
      if (ynabClient.isReadOnly() && writeToolNames.has(name)) {
        throw new ReadOnlyModeError(name);
      }
      const call = (): Promise<string> => handleToolCall(name, args ?? {}, ynabClient);
      let result: string;
      if (toolCalls === undefined) {
        result = await call();
      } else {
        // The handler returns by the request's deadline; the SDK delivers the
        // timeout like any tool error, over JSON or either era's SSE (D6, Q8).
        const outcome = await runWithin(toolCalls, call);
        if (!outcome.done) {
          const outcomeUnknown = outcome.started && writeToolNames.has(name);
          if (outcome.started) {
            console.error(`[Request] tools/call reached its deadline${outcomeUnknown ? ' (write; outcome unknown)' : ''}`);
          }
          return toolTimeoutResult(outcomeUnknown);
        }
        result = outcome.value;
      }
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

  server.setRequestHandler('prompts/list', async () => {
    return { prompts };
  });

  server.setRequestHandler('prompts/get', async (request) => {
    const { name, arguments: args } = request.params;

    try {
      return getPromptMessages(name, args ?? {});
    } catch (error) {
      // Client errors map to InvalidParams with a sanitized name only.
      if (error instanceof UnknownPromptError) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${sanitizePromptName(name)}`);
      }
      if (error instanceof InvalidPromptArgumentsError) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Invalid arguments for prompt ${sanitizePromptName(name)}: ${error.message}`
        );
      }
      // Anything else is ours. Log the detail server-side and return a generic
      // message, because the SDK forwards plain Error text to the client.
      console.error('[PromptError]', sanitizeErrorMessage(error));
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Failed to build prompt');
    }
  });

  return server;
}

/**
 * Build the MCP server for one HTTP request (ADR-0001 D2, D3): a YnabClient
 * on the user's shared components with this request's read-only flag, and
 * tool calls bounded by the request. Synchronous and cannot fail on input:
 * everything that can fail was resolved before the factory runs.
 */
export function createServerForRequest(ctx: RequestContext): Server {
  return createServerFromClient(buildYnabClient(ctx.user, ctx.components, ctx.toolCalls.deadline), ctx.toolCalls);
}

/**
 * Build the factory for the single-user (stdio) server from process config.
 * `serveStdio` may call it more than once per process (a discarded
 * `server/discover` probe, then the pinned connection), so the YnabClient, with
 * its rate limiter and cache, is built once here and every server shares it.
 * The mode line is printed once, not per call.
 */
export function createStdioServerFactory(config: Config): McpServerFactory {
  if (config.readOnly) {
    console.error('YNAB MCP Server running in READ-ONLY mode (write operations disabled)');
  } else {
    console.error('YNAB MCP Server running with WRITE operations ENABLED');
  }

  const client = buildYnabClient({
    accessToken: config.accessToken,
    defaultBudgetId: config.defaultBudgetId,
    readOnly: config.readOnly,
    rateLimitPerHour: config.rateLimitPerHour,
    rateLimitMaxWaitMs: config.rateLimitMaxWaitMs,
    cacheTtlMs: config.cacheTtlMs,
  });
  return () => createServerFromClient(client);
}
