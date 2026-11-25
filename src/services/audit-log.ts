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
  AUDIT_REVOKE_OPERATION,
  MAX_AUDIT_ROWS_PER_CALL,
  MemoryAuditStore,
  type AuditOperation,
  type AuditOutcome,
  type AuditQuery,
  type AuditRecord,
  type AuditResourceType,
  type AuditRevocationOutcome,
  type AuditRevokedResourceType,
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
    await this.write([this.entry(event, event.resourceId)]);
  }

  /**
   * Record one write attempt that touched several records (a bulk write): one
   * row per id, all with the call's request id, written as one batched insert
   * under one bounded wait (as {@link record}), at most
   * MAX_AUDIT_ROWS_PER_CALL. With no id (nothing was written, or YNAB named
   * none) it records one row without a resource id. The ids must come from
   * YNAB's response, never from tool input.
   */
  async recordMany(event: Omit<AuditEvent, 'resourceId'>, resourceIds: readonly string[]): Promise<void> {
    const ids = [...new Set(resourceIds.map(id).filter((v): v is string => v !== undefined))];
    if (ids.length > MAX_AUDIT_ROWS_PER_CALL) {
      console.error(`[AUDIT] ${ids.length} items in one call; recording the first ${MAX_AUDIT_ROWS_PER_CALL}`);
      ids.length = MAX_AUDIT_ROWS_PER_CALL;
    }
    const entries = ids.length === 0 ? [this.entry(event, undefined)] : ids.map((r) => this.entry(event, r));
    await this.write(entries);
  }

  /**
   * Record a revocation this caller made (#60b, D-7a): the account tools'
   * (src/storage/account-store.ts), only when the revoke removed something.
   * The row's client, grant and request are the caller's; `resourceId` names
   * what was revoked (a grant id, or a client id for every grant of a client).
   */
  async recordRevocation(event: {
    resourceType: AuditRevokedResourceType;
    resourceId: string;
    outcome: AuditRevocationOutcome;
  }): Promise<void> {
    await this.write([
      {
        ...this.caller(),
        tool: this.calls.getStore()?.tool,
        operation: AUDIT_REVOKE_OPERATION,
        resourceType: event.resourceType,
        resourceId: id(event.resourceId),
        budgetId: undefined,
        outcome: event.outcome,
      },
    ]);
  }

  /** Who and when, for a row of this log. */
  private caller(): Pick<AuditRecord, 'ts' | 'userId' | 'clientId' | 'familyId' | 'requestId'> {
    const scope = this.calls.getStore();
    return {
      ts: this.now(),
      userId: this.context.userId,
      clientId: id(this.context.clientId),
      familyId: id(this.context.familyId),
      requestId: id(scope?.requestId ?? this.context.requestId),
    };
  }

  /** One write row. */
  private entry(event: Omit<AuditEvent, 'resourceId'>, resourceId: string | undefined): AuditRecord {
    return {
      ...this.caller(),
      tool: this.calls.getStore()?.tool ?? event.tool,
      operation: event.operation,
      resourceType: event.resourceType,
      resourceId: id(resourceId),
      budgetId: budgetIdOf(event.budgetId),
      outcome: event.outcome,
    };
  }

  /** Append the rows (one statement), waiting a bounded time; never throws. */
  private async write(entries: AuditRecord[]): Promise<void> {
    const scope = this.calls.getStore();
    if (scope) scope.recorded = true;
    const first = entries[0] as AuditRecord;
    const guard = this.context.generation === undefined ? undefined : { generation: this.context.generation };
    let append: Promise<unknown>;
    try {
      append = entries.length === 1 ? this.store.appendAuditEntry(first, guard) : this.store.appendAuditEntries(entries, guard);
    } catch (error) {
      append = Promise.reject(error);
    }
    await this.boundedWait(
      append.then(
        () => undefined,
        (error: unknown) => {
          console.error('[AUDIT] could not record an entry:', sanitizeErrorMessage(error));
        }
      )
    );
    // Server-side visibility: ids and vocabulary only, as the rows.
    const resource =
      entries.length > 1 ? ` (${entries.length} items)` : first.resourceId ? ` (${first.resourceId})` : '';
    console.error(`[AUDIT] ${first.outcome}: ${first.operation} on ${first.resourceType}${resource} via ${first.tool ?? 'oauth'}`);
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
