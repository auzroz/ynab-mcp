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
 * #60b adds two kinds of row and no column: one row per item of a bulk write
 * (each with its resource id, all with the call's request id), and
 * revocation rows (operation `revoke`; see {@link AUDIT_REVOCATION_OUTCOMES}).
 * `ts` (epoch ms) is indexed for the retention prune (`AUDIT_RETENTION_DAYS`,
 * a sweep step), `(user_id, ts)` for the per-user listing and the account
 * erase (`deleteUserData`, D-7b).
 */

import type { AddedTable, Dialect } from './migrations.js';

/** How a write attempt ended. */
export const AUDIT_WRITE_OUTCOMES = [
  'success',
  /** The operator's read-only mode (YNAB_READ_ONLY, or YNAB_OAUTH_ALLOW_WRITE off). */
  'denied_read_only',
  /** The caller's grant is read-only: the MCP token's scope or the user's YNAB grant. */
  'denied_scope',
  /** The per-user write cap (#61c, YNAB_WRITE_LIMIT_PER_HOUR); the first refusal of each episode. */
  'denied_write_limit',
  'error',
] as const;
export type AuditOutcome = (typeof AUDIT_WRITE_OUTCOMES)[number];

/**
 * Why a grant was revoked (#60b, D-7a): the outcome of a `revoke` row. Only
 * revocations are recorded, never issuance or a refresh.
 */
export const AUDIT_REVOCATION_OUTCOMES = [
  /** The user or their client revoked it: `/revoke`, or the account tools (ynab_revoke_connection). */
  'revoked',
  /**
   * A spent refresh token or code was presented again, or a client presented
   * another client's, so the grant was revoked (RFC 9700).
   */
  'revoked_reuse',
  /** Two requests spent the same refresh token or code at once; the second revoked the grant. */
  'revoked_replay',
] as const;
export type AuditRevocationOutcome = (typeof AUDIT_REVOCATION_OUTCOMES)[number];

/** Every outcome a row can carry: the tool's `outcome` filter. */
export const AUDIT_OUTCOMES = [...AUDIT_WRITE_OUTCOMES, ...AUDIT_REVOCATION_OUTCOMES] as const;

/**
 * What a write did. `move` is ynab_move_money; `import` the deprecated no-op
 * import. `audit_suppressed` is not a write: it marks where the user's hourly
 * budget of recorded refusals ran out, so later refusals in that hour are
 * missing from the log (its outcome is the refusal's, its tool the call's).
 */
export const AUDIT_WRITE_OPERATIONS = ['create', 'update', 'delete', 'move', 'import', 'audit_suppressed'] as const;
export type AuditOperation = (typeof AUDIT_WRITE_OPERATIONS)[number];

/** A revocation row's operation (#60b): its outcome says why, its resource what was revoked. */
export const AUDIT_REVOKE_OPERATION = 'revoke';

/** Every operation a row can carry: the tool's `operation` filter. */
export const AUDIT_OPERATIONS = [...AUDIT_WRITE_OPERATIONS, AUDIT_REVOKE_OPERATION] as const;

/** What a write acted on. */
export const AUDIT_WRITE_RESOURCE_TYPES = [
  'account',
  'category',
  'category_group',
  'payee',
  'transaction',
  'scheduled_transaction',
] as const;
export type AuditResourceType = (typeof AUDIT_WRITE_RESOURCE_TYPES)[number];

/**
 * What a revocation acted on: one grant (an MCP connection; `resource_id` is
 * its grant id), or every grant the user gave one client (`resource_id` is
 * the client id).
 */
export const AUDIT_REVOKED_RESOURCE_TYPES = ['grant', 'client'] as const;
export type AuditRevokedResourceType = (typeof AUDIT_REVOKED_RESOURCE_TYPES)[number];

/** Every resource type a row can carry: the tool's `resource_type` filter. */
export const AUDIT_RESOURCE_TYPES = [...AUDIT_WRITE_RESOURCE_TYPES, ...AUDIT_REVOKED_RESOURCE_TYPES] as const;

/**
 * Most rows one call writes: one per item of a bulk write. The bulk tools
 * accept at most 100 items, so this never truncates one of them; it bounds a
 * response that names more.
 */
export const MAX_AUDIT_ROWS_PER_CALL = 100;

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
  /**
   * One client's rows only: ynab_audit_log's default in oauth mode. Its
   * `all_clients` option leaves this unset; the user filter always applies.
   */
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
  /**
   * Append the rows of one call (a bulk write's items), all of one user, in
   * one statement: all are written or none (the guard applies as for one
   * row). Returns false when the guard refused them. Throws for an empty
   * batch or one with rows of several users.
   */
  appendAuditEntries(entries: readonly AuditRecord[], guard?: AuditGuard): Promise<boolean>;
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

/** Postgres types of {@link COLUMNS}, in order. */
const PG_TYPES = ['bigint', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'];
const COLUMN_NAMES = COLUMNS.split(', ');

/** The user every row of a batch belongs to. Throws for an empty batch or one of several users. */
export function batchUser(entries: readonly AuditRecord[]): string {
  const userId = entries[0]?.userId;
  if (userId === undefined) throw new Error('An audit batch needs at least one row');
  if (entries.some((e) => e.userId !== userId)) throw new Error("An audit batch holds one user's rows only");
  return userId;
}

/**
 * One INSERT for a batch of rows, with a fixed number of parameters whatever
 * its size: on Postgres one array per column (`unnest`), on SQLite one JSON
 * array of rows (`json_each`). With a guard it inserts only while the user row
 * of that generation exists, as {@link auditInsert}; on Postgres it holds that
 * row FOR KEY SHARE, so the whole batch lands before an erase or not at all.
 */
export function auditInsertMany(
  dialect: Dialect,
  entries: readonly AuditRecord[],
  guard?: AuditGuard
): { sql: string; params: unknown[] } {
  const userId = batchUser(entries);
  const rows = entries.map(values);
  if (dialect === 'postgres') {
    const params: unknown[] = COLUMN_NAMES.map((_, i) => rows.map((r) => r[i]));
    const arrays = COLUMN_NAMES.map((_, i) => `$${i + 1}::${PG_TYPES[i]}[]`).join(', ');
    const source = `unnest(${arrays}) AS r(${COLUMNS})`;
    const select = COLUMN_NAMES.map((c) => `r.${c}`).join(', ');
    if (guard === undefined) {
      return { sql: `INSERT INTO audit_log (${COLUMNS}) SELECT ${select} FROM ${source}`, params };
    }
    const u = params.length + 1;
    return {
      sql: `INSERT INTO audit_log (${COLUMNS})
        SELECT ${select} FROM users u CROSS JOIN ${source}
        WHERE u.user_id = $${u} AND COALESCE(u.created_at, 0) = $${u + 1}::bigint FOR KEY SHARE OF u`,
      params: [...params, userId, guard.generation],
    };
  }
  const select = COLUMN_NAMES.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ');
  const base = `INSERT INTO audit_log (${COLUMNS}) SELECT ${select} FROM json_each($1)`;
  const params: unknown[] = [JSON.stringify(rows)];
  if (guard === undefined) return { sql: base, params };
  return {
    sql: `${base} WHERE EXISTS (SELECT 1 FROM users WHERE user_id = $2 AND COALESCE(created_at, 0) = $3)`,
    params: [...params, userId, guard.generation],
  };
}

/**
 * One batch of the retention prune: up to `$2` rows older than `$1` (epoch
 * ms), found through the `(ts)` index. On Postgres a batch skips rows another
 * transaction holds; a later pass picks them up.
 */
export function auditPruneSql(dialect: Dialect): string {
  const lock = dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';
  return `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts < $1 LIMIT $2${lock})`;
}

/**
 * Refuse a prune batch size that is not a positive safe integer: a batch of 0
 * would never come back short, and SQLite reads a negative LIMIT as none.
 */
export function assertPruneBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error('The audit prune batch size must be a positive integer');
  }
}

/**
 * Run the prune in batches of `batchSize`, each its own statement (so its own
 * short transaction), until one comes back short. Returns the rows deleted.
 */
export async function runAuditPrune(
  run: (sql: string, params: readonly unknown[]) => Promise<number>,
  dialect: Dialect,
  before: number,
  batchSize: number
): Promise<number> {
  assertPruneBatchSize(batchSize);
  const sql = auditPruneSql(dialect);
  let total = 0;
  for (;;) {
    const deleted = await run(sql, [before, batchSize]);
    total += deleted;
    if (deleted < batchSize) return total;
  }
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

  async appendAuditEntries(entries: readonly AuditRecord[]): Promise<boolean> {
    batchUser(entries);
    for (const e of entries) this.append(e);
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

  /** Delete every row older than `before` (epoch ms); returns how many. */
  prune(before: number): number {
    let n = 0;
    for (const [userId, list] of this.rows) {
      const kept = list.filter((e) => e.ts >= before);
      n += list.length - kept.length;
      if (kept.length === 0) this.rows.delete(userId);
      else if (kept.length !== list.length) this.rows.set(userId, kept);
    }
    return n;
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
