/**
 * The audit log's storage (#60a, schema 7): one `audit_log` row per write
 * attempt, on every driver. The service that writes and reads it is
 * src/services/audit-log.ts.
 *
 * A row says who (user, MCP client, grant, request), what (tool, operation,
 * resource type and id, budget) and how it ended (`outcome`). It holds no
 * amount or other financial value and no payee, account, category or memo
 * text: there is no column that could hold one (no free-form details, no
 * error message).
 *
 * The columns a later step fills for other kinds of event (#60b's revocation
 * rows have no tool or resource) are nullable, so it needs no migration.
 * `ts` (epoch ms) is indexed for #60b's retention prune, `(user_id, ts)` for
 * the per-user listing and the account erase (`deleteUserData`, D-7b).
 */

import type { AddedTable, Dialect } from './migrations.js';

/** How a write attempt ended. */
export const AUDIT_OUTCOMES = [
  'success',
  /** The operator's read-only mode (YNAB_READ_ONLY, or YNAB_OAUTH_ALLOW_WRITE off). */
  'denied_read_only',
  /** The caller's grant is read-only: the MCP token's scope or the user's YNAB grant. */
  'denied_scope',
  /** The per-user write cap (#61c, YNAB_WRITE_LIMIT_PER_HOUR); the first refusal of each episode. */
  'denied_write_limit',
  'error',
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * What a write did. `move` is ynab_move_money; `import` the deprecated no-op
 * import. `audit_suppressed` is not a write: it marks where the user's hourly
 * budget of recorded refusals ran out, so later refusals in that hour are
 * missing from the log (its outcome is the refusal's, its tool the call's).
 */
export const AUDIT_OPERATIONS = ['create', 'update', 'delete', 'move', 'import', 'audit_suppressed'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

/** What a write acted on. */
export const AUDIT_RESOURCE_TYPES = [
  'account',
  'category',
  'category_group',
  'payee',
  'transaction',
  'scheduled_transaction',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/**
 * One row. Values are read back as stored, so a row a newer release wrote
 * (an operation or outcome this one doesn't know) still lists.
 */
export interface AuditRecord {
  /** Epoch ms. */
  ts: number;
  /** The registry user key: the YNAB user id (oauth), the token's digest (header mode), `local` (stdio). */
  userId: string;
  /** The MCP client (oauth mode). */
  clientId: string | undefined;
  /** The client's grant (oidc-provider grant id; the token family). */
  familyId: string | undefined;
  /** The HTTP request, or one tools/call on stdio. */
  requestId: string | undefined;
  tool: string | undefined;
  operation: string;
  resourceType: string | undefined;
  resourceId: string | undefined;
  budgetId: string | undefined;
  outcome: string;
}

/** Filters of {@link AuditStore.listAuditEntries}; all optional and ANDed. */
export interface AuditQuery {
  operation?: string | undefined;
  resourceType?: string | undefined;
  /** Any of these outcomes. */
  outcomes?: readonly string[] | undefined;
  /** Rows at or after this time (epoch ms). */
  since?: number | undefined;
  /** One client's rows only (#60b's default filter; unused in 60a). */
  clientId?: string | undefined;
}

/**
 * A row is written only while the user row of this account generation
 * exists (oauth mode), so a write that settles after the account was erased
 * (or erased and connected again) leaves no row behind (D-7b). On Postgres
 * the insert holds the user row FOR KEY SHARE, so an erase in flight either
 * waits for it and deletes the row, or has deleted the user first and the
 * insert writes nothing.
 */
export interface AuditGuard {
  /** The user row's `created_at` (0 for a user from before 0.5.0). */
  generation: number;
}

export interface AuditStore {
  /** Append a row. Returns false when the guard refused it (the account is gone). */
  appendAuditEntry(entry: AuditRecord, guard?: AuditGuard): Promise<boolean>;
  /** The user's rows matching `query`, newest first, at most `limit`. */
  listAuditEntries(userId: string, query: AuditQuery, limit: number): Promise<AuditRecord[]>;
  /** The number of the user's rows matching `query`, per outcome. */
  countAuditEntries(userId: string, query: AuditQuery): Promise<Record<string, number>>;
}

/** M6 (schema 7): the table and its indexes. 0.4.x and 0.5.0 before schema 7 ignore it. */
export const AUDIT_LOG_TABLE: AddedTable = {
  name: 'audit_log',
  sql: {
    sqlite: `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT,
        family_id TEXT,
        request_id TEXT,
        tool TEXT,
        operation TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        budget_id TEXT,
        outcome TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_user_ts ON audit_log (user_id, ts);
      CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts)`,
    postgres: `CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT,
        family_id TEXT,
        request_id TEXT,
        tool TEXT,
        operation TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        budget_id TEXT,
        outcome TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_user_ts ON audit_log (user_id, ts);
      CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts)`,
  },
};

const COLUMNS =
  'ts, user_id, client_id, family_id, request_id, tool, operation, resource_type, resource_id, budget_id, outcome';

/** The row's values, in {@link COLUMNS} order. */
function values(e: AuditRecord): unknown[] {
  return [
    e.ts,
    e.userId,
    e.clientId ?? null,
    e.familyId ?? null,
    e.requestId ?? null,
    e.tool ?? null,
    e.operation,
    e.resourceType ?? null,
    e.resourceId ?? null,
    e.budgetId ?? null,
    e.outcome,
  ];
}

/**
 * The INSERT and its parameters (`$1`-style, in order, once each). With a
 * guard it inserts only while the user row of that generation exists, and on
 * Postgres holds that row FOR KEY SHARE (see {@link AuditGuard}).
 */
export function auditInsert(dialect: Dialect, entry: AuditRecord, guard?: AuditGuard): { sql: string; params: unknown[] } {
  const params = values(entry);
  const placeholders = params.map((_, i) => `$${i + 1}`);
  if (guard === undefined) {
    return { sql: `INSERT INTO audit_log (${COLUMNS}) VALUES (${placeholders.join(', ')})`, params };
  }
  const u = params.length + 1;
  const g = params.length + 2;
  if (dialect === 'postgres') {
    // Typed, since a SELECT list's parameters are not inferred from the target columns.
    const types = ['bigint', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'];
    const select = placeholders.map((p, i) => `${p}::${types[i]}`).join(', ');
    return {
      sql: `INSERT INTO audit_log (${COLUMNS})
        SELECT ${select} FROM users WHERE user_id = $${u} AND COALESCE(created_at, 0) = $${g}::bigint FOR KEY SHARE`,
      params: [...params, entry.userId, guard.generation],
    };
  }
  return {
    sql: `INSERT INTO audit_log (${COLUMNS})
      SELECT ${placeholders.join(', ')}
      WHERE EXISTS (SELECT 1 FROM users WHERE user_id = $${u} AND COALESCE(created_at, 0) = $${g})`,
    params: [...params, entry.userId, guard.generation],
  };
}

/** The WHERE clause of a user's rows matching `query`, and its parameters from `$1`. */
function auditWhere(dialect: Dialect, userId: string, query: AuditQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [userId];
  const clauses = ['user_id = $1'];
  const add = (clause: (p: string) => string, value: unknown): void => {
    params.push(value);
    clauses.push(clause(`$${params.length}`));
  };
  if (query.operation !== undefined) add((p) => `operation = ${p}`, query.operation);
  if (query.resourceType !== undefined) add((p) => `resource_type = ${p}`, query.resourceType);
  if (query.since !== undefined) add((p) => `ts >= ${p}`, query.since);
  if (query.clientId !== undefined) add((p) => `client_id = ${p}`, query.clientId);
  if (query.outcomes !== undefined) {
    if (dialect === 'postgres') add((p) => `outcome = ANY(${p}::text[])`, [...query.outcomes]);
    else add((p) => `outcome IN (SELECT value FROM json_each(${p}))`, JSON.stringify(query.outcomes));
  }
  return { where: clauses.join(' AND '), params };
}

/** The listing: newest first (by time, then insertion order), at most `limit`. */
export function auditListSql(
  dialect: Dialect,
  userId: string,
  query: AuditQuery,
  limit: number
): { sql: string; params: unknown[] } {
  const { where, params } = auditWhere(dialect, userId, query);
  params.push(limit);
  return {
    sql: `SELECT ${COLUMNS} FROM audit_log WHERE ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
    params,
  };
}

/** Counts per outcome. */
export function auditCountSql(dialect: Dialect, userId: string, query: AuditQuery): { sql: string; params: unknown[] } {
  const { where, params } = auditWhere(dialect, userId, query);
  return { sql: `SELECT outcome, COUNT(*) AS n FROM audit_log WHERE ${where} GROUP BY outcome`, params };
}

/** One row as a driver returns it (`ts` may be a string: Postgres BIGINT). */
export interface AuditRow {
  ts: number | string;
  user_id: string;
  client_id: string | null;
  family_id: string | null;
  request_id: string | null;
  tool: string | null;
  operation: string;
  resource_type: string | null;
  resource_id: string | null;
  budget_id: string | null;
  outcome: string;
}

export function auditRecordFromRow(row: AuditRow): AuditRecord {
  return {
    ts: Number(row.ts),
    userId: row.user_id,
    clientId: row.client_id ?? undefined,
    familyId: row.family_id ?? undefined,
    requestId: row.request_id ?? undefined,
    tool: row.tool ?? undefined,
    operation: row.operation,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    budgetId: row.budget_id ?? undefined,
    outcome: row.outcome,
  };
}

/** Whether `e` matches `query` (memory stores; the same rules as the SQL). */
export function auditMatches(e: AuditRecord, query: AuditQuery): boolean {
  if (query.operation !== undefined && e.operation !== query.operation) return false;
  if (query.resourceType !== undefined && e.resourceType !== query.resourceType) return false;
  if (query.since !== undefined && e.ts < query.since) return false;
  if (query.clientId !== undefined && e.clientId !== query.clientId) return false;
  if (query.outcomes !== undefined && !query.outcomes.includes(e.outcome)) return false;
  return true;
}

/** Default bound on one user's rows in a memory store (as the 0.4.x ring). */
export const MEMORY_AUDIT_ENTRIES_PER_USER = 1000;

/**
 * The memory audit store: stdio and header-mode HTTP (D-7c), and
 * MemoryStorage. Each user keeps their newest `maxEntriesPerUser` rows; the
 * oldest goes first. Lost on restart.
 */
export class MemoryAuditStore implements AuditStore {
  private readonly rows = new Map<string, AuditRecord[]>();

  constructor(private readonly maxEntriesPerUser: number = MEMORY_AUDIT_ENTRIES_PER_USER) {}

  async appendAuditEntry(entry: AuditRecord): Promise<boolean> {
    this.append(entry);
    return true;
  }

  /** Synchronous append, for MemoryStorage's guarded write. */
  append(entry: AuditRecord): void {
    let list = this.rows.get(entry.userId);
    if (list === undefined) {
      list = [];
      this.rows.set(entry.userId, list);
    }
    list.push({ ...entry });
    if (list.length > this.maxEntriesPerUser) list.splice(0, list.length - this.maxEntriesPerUser);
  }

  async listAuditEntries(userId: string, query: AuditQuery, limit: number): Promise<AuditRecord[]> {
    const matches: AuditRecord[] = [];
    const list = this.rows.get(userId) ?? [];
    // Newest inserted first, then a stable sort by time: the SQL order (ts
    // DESC, then id DESC), applied before the limit.
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i] as AuditRecord;
      if (auditMatches(e, query)) matches.push(e);
    }
    matches.sort((a, b) => b.ts - a.ts);
    return matches.slice(0, limit).map((e) => ({ ...e }));
  }

  async countAuditEntries(userId: string, query: AuditQuery): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const e of this.rows.get(userId) ?? []) {
      if (auditMatches(e, query)) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
    }
    return counts;
  }

  /** Erase a user's rows (the account erase). */
  deleteUser(userId: string): void {
    this.rows.delete(userId);
  }

  /** The user's row count (tests: the erase covers the audit rows). */
  countFor(userId: string): number {
    return this.rows.get(userId)?.length ?? 0;
  }
}
