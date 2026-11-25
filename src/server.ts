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
import { YnabClient, type AccessTokenSource, type ReadOnlyReason } from './services/ynab-client.js';
import { createUserComponents, type UserComponents } from './services/user-registry.js';
import { AuditLog, LOCAL_AUDIT_USER } from './services/audit-log.js';
import type { AuditOutcome, AuditStore } from './storage/audit-rows.js';
import { WRITE_TOOL_AUDIT_TARGETS } from './tools/audit-targets.js';
import { tools, accountTools, handleToolCall, handleAccountToolCall, isAccountToolName } from './tools/index.js';
import type { AccountToolContext, AccountToolSetup } from './tools/connections/context.js';
import { accountToolAllowed, accountToolDenial, type AccountToolName } from './tools/connections/policy.js';
import { UNTRUSTED_TEXT_NOTE } from './tools/untrusted-note.js';
import {
  prompts,
  getPromptMessages,
  sanitizePromptName,
  UnknownPromptError,
  InvalidPromptArgumentsError,
} from './prompts/index.js';
import { sanitizeErrorMessage } from './utils/sanitize.js';
import {
  AccountChangeNotAllowedError,
  formatErrorResponse,
  isInputValidationError,
  ReadOnlyModeError,
  WriteLimitError,
} from './utils/errors.js';
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
  /**
   * OAuth mode (#48): drop an access token YNAB answered 401 to, for every
   * replica, so the next call refreshes. See YnabClientOptions.onUnauthorized.
   */
  onUnauthorized?: ((rejectedAccessToken: string) => Promise<void>) | undefined;
  defaultBudgetId?: string | undefined;
  readOnly: boolean;
  /**
   * Why `readOnly` is set (#60a): the operator's setting (`read_only`, the
   * default) or the caller's grant (`scope`). Audited as the refused write's
   * outcome.
   */
  readOnlyReason?: ReadOnlyReason | undefined;
  /**
   * oauth mode: the account generation this request resolved (the user row's
   * `createdAt`). Audit rows are written only while it exists (AuditGuard).
   */
  generation?: number | undefined;
  rateLimitPerHour: number;
  /** Longest wait for a rate-limit token in ms (default 2000; 0 = never wait). */
  rateLimitMaxWaitMs?: number | undefined;
  cacheTtlMs: number;
  /** Write requests per user per hour (#61c); 0 = no cap. Default 20. */
  writeLimitPerHour?: number | undefined;
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
  /** Unique per request (for logs and the audit log's request id, #60a). */
  readonly requestId: string;
  /** The user's registry key: the YNAB user id (oauth), or the YNAB token's digest (header). */
  readonly userKey: string;
  /** The authenticated MCP client (oauth mode); undefined in header mode. */
  readonly clientId: string | undefined;
  /** The client's grant (oauth mode: the access token's oidc-provider grant id), for the audit log. */
  readonly familyId: string | undefined;
  /**
   * Where this request's audit rows go: the storage driver (oauth mode), or
   * the user's memory store (header mode, which has no storage).
   */
  readonly auditStore: AuditStore;
  /** The settings this request's YnabClient is built with, its read-only flag computed for this request. */
  readonly user: UserContext;
  /** The user's components, held by this request's registry lease. */
  readonly components: UserComponents;
  readonly toolCalls: ToolCallBounds;
  /** OAuth mode only: what the account tools (#53c) run with. Undefined in header mode, which has no connections. */
  readonly accountTools?: AccountToolSetup | undefined;
}

/** Per-request parts of a YnabClient (HTTP); stdio and tests leave them out. */
export interface ClientBuildOptions {
  /** The request's absolute deadline: no YNAB call outlives it (#58). */
  deadline?: number | undefined;
  /** The request's audit log; default: the user's memory store, as the stdio user. */
  auditLog?: AuditLog | undefined;
  /** The calling MCP client, for the per-client usage report (#58). */
  clientId?: string | undefined;
}

/**
 * Build a YnabClient on the given per-user components (rate limiter, cache,
 * delta snapshots, memory audit store, feed state). Without them it gets its
 * own set (stdio, tests).
 */
export function buildYnabClient(
  ctx: UserContext,
  components: UserComponents = createUserComponents(ctx),
  options: ClientBuildOptions = {}
): YnabClient {
  return new YnabClient(
    ctx.accessToken,
    ctx.defaultBudgetId,
    components.rateLimiter,
    components.cache,
    ctx.readOnly,
    options.auditLog ?? new AuditLog(components.auditStore, { userId: LOCAL_AUDIT_USER }),
    components.deltaCache,
    components.feedState,
    {
      breaker: components.breaker,
      deadline: options.deadline,
      writeLimiter: components.writeLimiter,
      onUnauthorized: ctx.onUnauthorized,
      clientId: options.clientId,
      clientUsage: components.clientUsage,
      auditedDenials: components.auditedDenials,
      readOnlyReason: ctx.readOnlyReason,
    }
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

/** An account tool (#53c) that hit its deadline: a revoke or erase that started may still complete. */
function accountToolTimeoutResult(outcomeUnknown: boolean): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (!outcomeUnknown) return toolTimeoutResult(false);
  const body = {
    error: true,
    type: 'request_timeout',
    message: 'Request timed out; the change may still have been applied',
    outcome: 'unknown',
    suggestion: 'Check with ynab_list_connections before retrying.',
  };
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
export function createServerFromClient(
  ynabClient: YnabClient,
  toolCalls?: ToolCallBounds,
  accountContext?: AccountToolContext
): Server {
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

  // The account tools this caller may run (OAuth mode only, #53c): the
  // policy's answer for this request, so a refused one is hidden as a write
  // tool is from a read-only caller. tools/call applies the policy again.
  const listedAccountTools =
    accountContext === undefined
      ? []
      : accountTools.filter((t) => accountToolAllowed(t.name as AccountToolName, accountContext));

  server.setRequestHandler('tools/list', async () => {
    // Hide write tools from read-only callers. This is a UX nicety only: the
    // YnabClient write guard still rejects writes server-side. Uses the
    // per-client value, computed per HTTP request (ADR-0001 D4).
    if (ynabClient.isReadOnly()) {
      return { tools: [...tools.filter((t) => t.annotations?.readOnlyHint === true), ...listedAccountTools] };
    }
    return { tools: [...tools, ...listedAccountTools] };
  });

  // How a refused or failed write is audited (#60a): the tool's operation and
  // resource type, no resource id (the arguments are not trusted for one).
  const auditLog = ynabClient.getAuditLog();
  const recordWrite = async (name: string, outcome: AuditOutcome, suppressed = false): Promise<void> => {
    const target = WRITE_TOOL_AUDIT_TARGETS[name];
    if (target === undefined) return;
    await auditLog.record({ ...target, ...(suppressed ? { operation: 'audit_suppressed' as const } : {}), tool: name, outcome });
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const isWrite = writeToolNames.has(name);
    try {
      // Reject oversized/deeply nested arguments before any zod parsing
      // (defense in depth against resource exhaustion).
      assertSafeToolInput(args);
      // A tool hidden from a read-only caller's list is rejected here too, so
      // calling it by name gets the same read-only error even when its handler
      // would not reach the client's write guard (the deprecated no-op import).
      // Recorded while the user's hourly budget of audited refusals lasts (a
      // refusal costs no write slot, so a looping client is bounded here).
      if (ynabClient.isReadOnly() && isWrite) {
        const outcome = ynabClient.getReadOnlyReason() === 'scope' ? 'denied_scope' : 'denied_read_only';
        const audit = ynabClient.admitDeniedAudit();
        // Past the budget: one marker row says later refusals this hour are not recorded.
        if (audit !== 'skip') await recordWrite(name, outcome, audit === 'mark');
        throw new ReadOnlyModeError(name);
      }
      // The per-user write cap (#61c, D-8): checked here, once per write tool
      // call, for every transport and every non-read-only tool, before the
      // handler and so before any YNAB request. A bulk call counts as one.
      // A call that fails Zod input validation never reaches YNAB, so it gives
      // its slot back; a call YNAB rejects still used quota and keeps it.
      // The first refusal of an episode is audited, so a looping agent adds one row.
      let releaseSlot: (() => void) | undefined;
      if (isWrite) {
        try {
          releaseSlot = ynabClient.admitWrite(name);
        } catch (error) {
          if (error instanceof WriteLimitError && error.firstRefusal) await recordWrite(name, 'denied_write_limit');
          throw error;
        }
      }
      const call = async (): Promise<string> => {
        try {
          return await handleToolCall(name, args, ynabClient);
        } catch (error) {
          if (releaseSlot !== undefined && isInputValidationError(error)) releaseSlot();
          // A write that failed before its client method recorded it (rate
          // limited, a budget lookup) is recorded here. Input validation
          // failures are not write attempts.
          if (isWrite && !isInputValidationError(error) && !auditLog.callRecorded()) {
            await recordWrite(name, 'error');
          }
          throw error;
        }
      };
      let result: string;
      if (toolCalls === undefined) {
        result = await call();
      } else {
        // The handler returns by the request's deadline; the SDK delivers the
        // timeout like any tool error, over JSON or either era's SSE (D6, Q8).
        const outcome = await runWithin(toolCalls, call);
        if (!outcome.done) {
          const outcomeUnknown = outcome.started && isWrite;
          // The handler never ran (deadline already passed, or the request had
          // ended): nothing reached YNAB, so the slot goes back. A write that
          // started and timed out keeps it, since it may have reached YNAB
          // (it is audited when it settles).
          if (!outcome.started) {
            releaseSlot?.();
            if (isWrite) await recordWrite(name, 'error');
          }
          if (outcome.started) {
            console.error(`[Request] tools/call reached its deadline${outcomeUnknown ? ' (write; outcome unknown)' : ''}`);
          }
          return toolTimeoutResult(outcomeUnknown);
        }
        result = outcome.value;
      }
      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: formatErrorResponse(error) }],
        isError: true as const,
      };
    }
  };

  /**
   * An account tool's call (#53c). It runs apart from the write path above:
   * its own policy instead of the YNAB read-only check, no write cap and no
   * write audit row (it makes no YNAB request; revocations are recorded by
   * AccountStore, #60b). It is bounded by the request like any tool call.
   */
  const callAccountTool = async (name: AccountToolName, args: Record<string, unknown>, ctx: AccountToolContext) => {
    try {
      assertSafeToolInput(args);
      const denial = accountToolDenial(name, ctx);
      if (denial !== undefined) throw new AccountChangeNotAllowedError(denial);
      const call = (): Promise<string> => handleAccountToolCall(name, args, ctx);
      let result: string;
      if (toolCalls === undefined) {
        result = await call();
      } else {
        const outcome = await runWithin(toolCalls, call);
        if (!outcome.done) return accountToolTimeoutResult(outcome.started && name !== 'ynab_list_connections');
        result = outcome.value;
      }
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: formatErrorResponse(error) }],
        isError: true as const,
      };
    }
  };

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    // Without an account context (stdio, header mode) an account tool's name
    // falls through to the registry below, which calls it an unknown tool.
    if (accountContext !== undefined && isAccountToolName(name)) {
      if (name === 'ynab_list_connections') return callAccountTool(name, args ?? {}, accountContext);
      // Revoke and disconnect run as one tools/call of the audit log, so whatever
      // AccountStore records names the tool (#60b). Nothing is recorded here.
      return auditLog.runCall(name, () => callAccountTool(name, args ?? {}, accountContext));
    }
    // A write tool runs as one audited call: every row it records names it and the request (#60a).
    if (writeToolNames.has(name)) return auditLog.runCall(name, () => callTool(name, args ?? {}));
    return callTool(name, args ?? {});
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
  // The request's audit log: its user, client, grant and request id (#60a).
  const auditLog = new AuditLog(ctx.auditStore, {
    userId: ctx.userKey,
    clientId: ctx.clientId,
    familyId: ctx.familyId,
    requestId: ctx.requestId,
    generation: ctx.user.generation,
    // A write never waits on its audit row past this call's deadline.
    deadline: ctx.toolCalls.deadline,
  });
  const client = buildYnabClient(ctx.user, ctx.components, {
    deadline: ctx.toolCalls.deadline,
    auditLog,
    clientId: ctx.clientId,
  });
  // The account tools' store is opened on this request's audit log (#53c, #60b).
  let accountContext: AccountToolContext | undefined;
  if (ctx.accountTools !== undefined) {
    const { openAccounts, ...rest } = ctx.accountTools;
    accountContext = Object.freeze({ ...rest, accounts: openAccounts(auditLog) });
  }
  return createServerFromClient(client, ctx.toolCalls, accountContext);
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
    writeLimitPerHour: config.writeLimitPerHour,
  });
  return () => createServerFromClient(client);
}
