/**
 * Storage time bounds (ADR-0001 D6, Q7): a request holding an in-flight slot
 * must not wait on storage forever. The defaults live here, in one place; the
 * driver options take overrides so tests can use short values. None of these
 * is an environment variable.
 *
 * The memory driver does no I/O, so it has nothing to bound.
 */

/** Postgres, server side: a statement running longer is cancelled by the server. */
export const DEFAULT_PG_STATEMENT_TIMEOUT_MS = 10_000;
/**
 * Postgres, client side: `pg`'s `query_timeout`. Above the statement timeout so
 * the server cancels first; this fires only when the server can't be reached
 * (a reply lost in a network partition). The connection is then discarded.
 */
export const DEFAULT_PG_QUERY_TIMEOUT_MS = 15_000;
/** Postgres: how long a request waits for a pooled connection (and for a new one to open). */
export const DEFAULT_PG_CONNECTION_TIMEOUT_MS = 10_000;
/**
 * SQLite: how long a statement waits for a lock held by another connection or
 * process. `better-sqlite3` is synchronous, so the wait blocks the whole event
 * loop (ceiling timers included). 5 s is the longest that is tolerable for
 * that, and enough for a second process's startup migration (an IMMEDIATE
 * transaction) to finish; routine writes hold the lock for milliseconds.
 */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface StorageTimeouts {
  pgStatementTimeoutMs: number;
  pgQueryTimeoutMs: number;
  pgConnectionTimeoutMs: number;
  sqliteBusyTimeoutMs: number;
}

export const DEFAULT_STORAGE_TIMEOUTS: StorageTimeouts = {
  pgStatementTimeoutMs: DEFAULT_PG_STATEMENT_TIMEOUT_MS,
  pgQueryTimeoutMs: DEFAULT_PG_QUERY_TIMEOUT_MS,
  pgConnectionTimeoutMs: DEFAULT_PG_CONNECTION_TIMEOUT_MS,
  sqliteBusyTimeoutMs: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
};

/** Defaults overlaid with overrides; a non-positive or non-integer value is a bug, not "no limit". */
export function resolveStorageTimeouts(overrides?: Partial<StorageTimeouts>): StorageTimeouts {
  const merged: StorageTimeouts = { ...DEFAULT_STORAGE_TIMEOUTS };
  for (const key of Object.keys(DEFAULT_STORAGE_TIMEOUTS) as (keyof StorageTimeouts)[]) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Storage timeout ${key} must be a positive integer (milliseconds)`);
    }
    merged[key] = value;
  }
  return merged;
}
