/**
 * Audit Log Service (#60a)
 *
 * Records every write attempt and how it ended, through an AuditStore: the
 * storage driver's `audit_log` table in oauth mode (memory, SQLite or
 * Postgres), and a per-user memory store on stdio and in header mode
 * (D-7c). Read back by the ynab_audit_log tool.
 *
 * One AuditLog is bound to one caller: the user, and in HTTP the MCP client,
 * its grant and the request (built per request, ADR-0001). On stdio one
 * serves the process and each tools/call gets its own request id.
 *
 * A row holds ids and fixed vocabulary only (see src/storage/audit-rows.ts):
 * no amounts or other financial values, no payee, account, category or memo
 * text, and no error message. The input type below has no field that could
 * carry one.
 *
 * Recording never throws: a store failure is logged (sanitized) and the
 * write's own result stands.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  MemoryAuditStore,
  type AuditOperation,
  type AuditOutcome,
  type AuditQuery,
  type AuditRecord,
  type AuditResourceType,
  type AuditStore,
} from '../storage/audit-rows.js';
import { sanitizeErrorMessage, sanitizeString } from '../utils/sanitize.js';
import { isBudgetIdSentinel } from '../utils/schemas.js';

/** The user key stdio records under (one user per process). */
export const LOCAL_AUDIT_USER = 'local';

/** Longest id kept in a row; YNAB and MCP ids are far shorter. */
const MAX_ID_LENGTH = 200;

/**
 * Longest a write waits for its audit row (ms). A write YNAB has applied must
 * not wait on a slow store until the request's deadline fires and the client
 * is told its outcome is unknown (and retries into a duplicate): past this,
 * the append finishes in the background, a failure logged as any other.
 */
export const AUDIT_APPEND_MAX_WAIT_MS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A budget id as YNAB names one (a UUID, `last-used` or `default`), else nothing: never free text. */
function budgetIdOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return UUID.test(value) || isBudgetIdSentinel(value) ? value : undefined;
}

/** Who the entries of one AuditLog belong to. */
export interface AuditContext {
  /** The registry user key (see AuditRecord.userId). */
  userId: string;
  clientId?: string | undefined;
  /** The client's grant (the oidc-provider grant id). */
  familyId?: string | undefined;
  /** The HTTP request; on stdio each tools/call gets one (see runCall). */
  requestId?: string | undefined;
  /**
   * oauth mode: the account generation the request resolved. Entries are
   * then written only while that user row exists (AuditGuard), so a write
   * settling after the account was erased leaves no row (D-7b).
   */
  generation?: number | undefined;
  /**
   * The tool call's deadline (epoch ms, HTTP). A write waits for its row at
   * most half the time left before it, and never more than
   * AUDIT_APPEND_MAX_WAIT_MS.
   */
  deadline?: number | undefined;
}

/** One write attempt, as a caller reports it. */
export interface AuditEvent {
  operation: AuditOperation;
  resourceType: AuditResourceType;
  /** The tool this write belongs to when no tools/call is in progress (the call's tool wins). */
  tool: string;
  resourceId?: string | undefined;
  budgetId?: string | undefined;
  outcome: AuditOutcome;
}

/** The tools/call in progress (see runCall). */
interface CallScope {
  tool: string;
  requestId: string | undefined;
  recorded: boolean;
}

function id(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeString(value, MAX_ID_LENGTH);
  return clean === null || clean === '' ? undefined : clean;
}

export class AuditLog {
  private readonly calls = new AsyncLocalStorage<CallScope>();

  /**
   * `store` defaults to a memory store of this log's own (tests); stdio and
   * HTTP pass theirs. `context` defaults to the stdio user.
   */
  constructor(
    private readonly store: AuditStore = new MemoryAuditStore(),
    private readonly context: AuditContext = { userId: LOCAL_AUDIT_USER },
    private readonly now: () => number = Date.now,
    private readonly maxWaitMs: number = AUDIT_APPEND_MAX_WAIT_MS
  ) {}

  /**
   * Run one tools/call. Entries recorded inside it (in the client's write
   * methods, however deep) name this tool, so a bulk or composite tool
   * (ynab_create_transactions, ynab_move_money) is recorded as itself, and
   * carry the request id: the context's (HTTP), else a fresh one (stdio).
   */
  runCall<T>(tool: string, work: () => Promise<T>): Promise<T> {
    const scope: CallScope = { tool, requestId: this.context.requestId ?? randomUUID(), recorded: false };
    return this.calls.run(scope, work);
  }

  /** Whether the tools/call in progress has recorded an entry yet. */
  callRecorded(): boolean {
    return this.calls.getStore()?.recorded ?? false;
  }

  /**
   * Record one write attempt. Never throws, and waits for the store a bounded
   * time only (see AUDIT_APPEND_MAX_WAIT_MS): a slower append completes in the
   * background.
   */
  async record(event: AuditEvent): Promise<void> {
    const scope = this.calls.getStore();
    if (scope) scope.recorded = true;
    const entry: AuditRecord = {
      ts: this.now(),
      userId: this.context.userId,
      clientId: id(this.context.clientId),
      familyId: id(this.context.familyId),
      requestId: id(scope?.requestId ?? this.context.requestId),
      tool: scope?.tool ?? event.tool,
      operation: event.operation,
      resourceType: event.resourceType,
      resourceId: id(event.resourceId),
      budgetId: budgetIdOf(event.budgetId),
      outcome: event.outcome,
    };
    const guard = this.context.generation === undefined ? undefined : { generation: this.context.generation };
    const append = this.store.appendAuditEntry(entry, guard).then(
      () => undefined,
      (error: unknown) => {
        console.error('[AUDIT] could not record an entry:', sanitizeErrorMessage(error));
      }
    );
    await this.boundedWait(append);
    // Server-side visibility: ids and vocabulary only, as the row.
    const resource = entry.resourceId ? ` (${entry.resourceId})` : '';
    console.error(`[AUDIT] ${entry.outcome}: ${entry.operation} on ${entry.resourceType}${resource} via ${entry.tool}`);
  }

  /**
   * The MCP client this log records for (oauth mode); undefined on stdio and
   * in header mode, where the user is the only caller.
   */
  get clientId(): string | undefined {
    return id(this.context.clientId);
  }

  /** Wait for `work`, or until the cap (and half the time left before the deadline) has passed. */
  private async boundedWait(work: Promise<void>): Promise<void> {
    const deadline = this.context.deadline;
    const left = deadline === undefined ? Infinity : Math.max(0, (deadline - Date.now()) / 2);
    const waitMs = Math.min(this.maxWaitMs, left);
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref();
    });
    try {
      await Promise.race([work, capped]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** This user's entries matching `query`, newest first. */
  list(query: AuditQuery, limit: number): Promise<AuditRecord[]> {
    return this.store.listAuditEntries(this.context.userId, query, limit);
  }

  /** The number of this user's entries matching `query`, per outcome. */
  counts(query: AuditQuery): Promise<Record<string, number>> {
    return this.store.countAuditEntries(this.context.userId, query);
  }
}
