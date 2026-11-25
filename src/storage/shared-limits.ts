/**
 * Shared rate-limit state (#67, schema 8): the tables, their SQL, and the
 * Postgres store that `RATE_LIMIT_STORE=postgres` puts behind the limiters, so
 * every replica on one database counts against one budget.
 *
 * Three tables, created on both SQL dialects (the migration plan is shared, and
 * the account erase runs its DELETE everywhere). Only the Postgres store reads
 * or writes them; on SQLite they stay empty.
 *
 *  - `rate_limit_hits`: express-rate-limit's fixed windows (#67b), one row per
 *    (limiter, key). `limiter` is the limiter's name (rate-limiters.ts), `key`
 *    an HMAC of the limiter's name and key (a client address, a (client_id,
 *    address) pair, a redirect host) under a key derived from the token
 *    pepper (TokenHasher.limiterKey): a long key can't exceed an index entry,
 *    and a copy of the database can't be enumerated back to addresses
 *    without the pepper, which every replica shares. A hit is one
 *    `INSERT ... ON CONFLICT DO UPDATE` that starts a new window when the old
 *    one has ended: atomic across replicas.
 *  - `rate_limit_buckets`: the per-user YNAB request budget (#67c), one row
 *    per user as a GCRA bucket. `tat` (theoretical arrival time, epoch ms) is
 *    when the bucket will be full again: a request costs `I = ceil(1 h / cap)`
 *    ms, and is granted while `max(tat, now) + I - now <= B` (`B = cap * I`,
 *    the bucket's size in time). `tat <= now` is a full bucket, so a missing
 *    row is one too and the sweep may delete such rows. `blocked_until` is
 *    YNAB's own 429 window, shared so no replica keeps sending into it. The
 *    column is named `user_id` so the account erase finds it
 *    (src/storage/user-data.ts).
 *  - `rate_limit_writes`: the per-user write cap (#61c, YNAB_WRITE_LIMIT_PER_HOUR),
 *    one row per user holding the admission times of the last hour
 *    (`admitted`, a BIGINT[] on Postgres), so the window stays #61c's sliding
 *    one: at most `limit` writes in any 60 minutes. `refused_since_admit` makes
 *    "the first refusal of an episode" (the one #60a audits) one per user
 *    across replicas. `last_admitted_at` is the sweep's clock. Keyed by
 *    `user_id` for the account erase.
 *
 * Time is the database's clock (`statement_timestamp()`), never a replica's,
 * so replicas whose clocks drift can't mint tokens.
 *
 * When the database can't be reached or is slow, the store throws
 * {@link SharedLimitUnavailableError} within the limiter pool's short time
 * bounds (src/storage/timeouts.ts). Callers fail closed: there is no
 * in-memory fallback, which would give each replica its own budget again.
 */

import type { Pool as PgPool } from 'pg';
import type { AddedTable, Dialect } from './migrations.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

/** M7 (schema 8, #67b): the fixed windows of the authorization server's limiters. */
export const RATE_LIMIT_HITS_TABLE: AddedTable = {
  name: 'rate_limit_hits',
  sql: {
    sqlite: `CREATE TABLE IF NOT EXISTS rate_limit_hits (
        limiter TEXT NOT NULL,
        key TEXT NOT NULL,
        hits INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        PRIMARY KEY (limiter, key)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_hits_reset_at ON rate_limit_hits (reset_at)`,
    postgres: `CREATE TABLE IF NOT EXISTS rate_limit_hits (
        limiter TEXT NOT NULL,
        key TEXT NOT NULL,
        hits BIGINT NOT NULL,
        reset_at BIGINT NOT NULL,
        PRIMARY KEY (limiter, key)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_hits_reset_at ON rate_limit_hits (reset_at)`,
  },
};

/** M7 (schema 8, #67c): the per-user YNAB request budget. */
export const RATE_LIMIT_BUCKETS_TABLE: AddedTable = {
  name: 'rate_limit_buckets',
  sql: {
    sqlite: `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        user_id TEXT PRIMARY KEY,
        tat INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rate_limit_buckets_tat ON rate_limit_buckets (tat)`,
    postgres: `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        user_id TEXT PRIMARY KEY,
        tat BIGINT NOT NULL,
        blocked_until BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rate_limit_buckets_tat ON rate_limit_buckets (tat)`,
  },
};

/** M7 (schema 8, #61c across replicas): the per-user write cap's admissions. */
export const RATE_LIMIT_WRITES_TABLE: AddedTable = {
  name: 'rate_limit_writes',
  sql: {
    // Unused on SQLite (shared limits need Postgres): the admissions as JSON text.
    sqlite: `CREATE TABLE IF NOT EXISTS rate_limit_writes (
        user_id TEXT PRIMARY KEY,
        admitted TEXT NOT NULL DEFAULT '[]',
        refused_since_admit INTEGER NOT NULL DEFAULT 0,
        last_admitted_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rate_limit_writes_last_admitted_at ON rate_limit_writes (last_admitted_at)`,
    postgres: `CREATE TABLE IF NOT EXISTS rate_limit_writes (
        user_id TEXT PRIMARY KEY,
        admitted BIGINT[] NOT NULL DEFAULT '{}',
        refused_since_admit BOOLEAN NOT NULL DEFAULT FALSE,
        last_admitted_at BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rate_limit_writes_last_admitted_at ON rate_limit_writes (last_admitted_at)`,
  },
};

/** The write cap's window (#61c): an admission counts for this long. */
export const SHARED_WRITE_WINDOW_MS = 60 * 60 * 1000;

/** What one write admission found (epoch ms, database clock). */
export interface WriteCapState {
  allowed: boolean;
  /** For a refusal: whether it is the first since the user's last admitted write (on any replica). */
  firstRefusal: boolean;
  /** For a refusal: when the oldest admission in the window leaves it. */
  resetsAt: number;
  /** The database's clock: for an admission, its recorded time (what releaseWrite takes back). */
  now: number;
}

/** A window's count after a hit, and when it ends (epoch ms, database clock). */
export interface WindowHits {
  hits: number;
  resetAt: number;
}

/** A user's bucket as one statement left it (epoch ms, database clock). */
export interface BucketState {
  /** `tat` before the statement: unchanged by a refusal. */
  previousTat: number;
  /** `tat` after it; greater than previousTat exactly when tokens were taken. */
  tat: number;
  /** YNAB's 429 window, or 0. */
  blockedUntil: number;
  /** The database's clock when the statement ran. */
  now: number;
}

/** A bucket's shape: `intervalMs` per request, `burstMs` (= capacity * interval) in all. */
export interface BucketShape {
  intervalMs: number;
  burstMs: number;
}

/** What the shared limiters need from the database. Every method throws {@link SharedLimitUnavailableError} on failure. */
export interface SharedLimitStore {
  /** Count one hit in `limiter`'s window for `key`, starting a new window of `windowMs` when the last one ended. */
  hit(limiter: string, key: string, windowMs: number): Promise<WindowHits>;
  /** Take back one hit in the current window (express-rate-limit's decrement). */
  unhit(limiter: string, key: string): Promise<void>;
  /** Forget `key`'s window. */
  resetHits(limiter: string, key: string): Promise<void>;
  /** The current window, or undefined when there is none. */
  getHits(limiter: string, key: string): Promise<WindowHits | undefined>;
  /**
   * Take `count` tokens from the user's bucket if it holds them, all or none.
   * With `maxDebtMs > 0` and nobody else waiting, a request the bucket can
   * serve within `maxDebtMs` is booked now (the caller sleeps until its
   * token arrives): at most one such waiter per user across every replica.
   */
  take(userId: string, count: number, shape: BucketShape, maxDebtMs: number): Promise<BucketState>;
  /** Give back `count` tokens taken for requests that were never sent; never beyond a full bucket. */
  give(userId: string, count: number, shape: BucketShape): Promise<void>;
  /** Note YNAB's 429: refuse the user's requests on every replica for `windowMs`. */
  block(userId: string, windowMs: number): Promise<void>;
  /** The bucket without changing it (a missing row reads as full). */
  peek(userId: string): Promise<BucketState>;
  /** Admit one write if fewer than `limit` were admitted in the last `windowMs`, recording it; else refuse. */
  admitWrite(userId: string, limit: number, windowMs: number): Promise<WriteCapState>;
  /** Give back the admission recorded at `admittedAt` (a write that failed input validation). */
  releaseWrite(userId: string, admittedAt: number): Promise<void>;
}

/** Derives the stored form of a limiter key (TokenHasher.limiterKey: an HMAC under a pepper-derived key). */
export interface LimiterKeyDeriver {
  limiterKey(limiter: string, key: string): string;
}

/** The shared store could not be reached in time. The message is fixed; the cause is logged once in a while. */
export class SharedLimitUnavailableError extends Error {
  constructor() {
    super('Shared rate-limit store unavailable');
    this.name = 'SharedLimitUnavailableError';
  }
}

/** How long a caller is told to wait when the shared store is unavailable. */
export const SHARED_LIMIT_RETRY_AFTER_MS = 5_000;

/** The database's clock in epoch ms, once per statement. */
const DB_NOW = '(EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint';

const HIT_SQL = `INSERT INTO rate_limit_hits AS h (limiter, key, hits, reset_at)
  SELECT $1, $2, 1, n.ms + $3::bigint FROM (SELECT ${DB_NOW} AS ms) AS n
  ON CONFLICT (limiter, key) DO UPDATE SET
    hits = CASE WHEN h.reset_at <= EXCLUDED.reset_at - $3::bigint THEN 1 ELSE h.hits + 1 END,
    reset_at = CASE WHEN h.reset_at <= EXCLUDED.reset_at - $3::bigint THEN EXCLUDED.reset_at ELSE h.reset_at END
  RETURNING hits, reset_at`;

const UNHIT_SQL = `UPDATE rate_limit_hits SET hits = hits - 1
  WHERE limiter = $1 AND key = $2 AND hits > 0 AND reset_at > ${DB_NOW}`;

const RESET_HITS_SQL = 'DELETE FROM rate_limit_hits WHERE limiter = $1 AND key = $2';

const GET_HITS_SQL = `SELECT hits, reset_at FROM rate_limit_hits
  WHERE limiter = $1 AND key = $2 AND reset_at > ${DB_NOW}`;

/**
 * The GCRA take, in one statement under the row's lock. The FOR UPDATE
 * subquery reads the row as it was, so RETURNING has both the old and the new
 * `tat` (a refusal leaves it unchanged). Parameters: $1 user, $2 count, $3 the
 * interval, $4 the burst, $5 the longest booking allowed (0: never book).
 * Granted when not blocked, nobody holds a booking (`tat - now <= B`), and the
 * new `tat` is at most `$5` past a full bucket's limit.
 */
const TAKE_SQL = `UPDATE rate_limit_buckets AS t
  SET tat = CASE
      WHEN o.blocked_until <= n.ms
        AND o.tat - n.ms <= $4::bigint
        AND GREATEST(o.tat, n.ms) + $2::bigint * $3::bigint - n.ms - $4::bigint <= $5::bigint
      THEN GREATEST(o.tat, n.ms) + $2::bigint * $3::bigint
      ELSE o.tat END
  FROM (SELECT tat, blocked_until FROM rate_limit_buckets WHERE user_id = $1 FOR UPDATE) AS o,
       (SELECT ${DB_NOW} AS ms) AS n
  WHERE t.user_id = $1
  RETURNING o.tat AS previous_tat, t.tat AS tat, t.blocked_until AS blocked_until, n.ms AS now`;

/** A new user's row: a full bucket (tat 0 is long past). */
const CREATE_BUCKET_SQL =
  'INSERT INTO rate_limit_buckets (user_id, tat, blocked_until) VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING';

/** Give tokens back, never past full (`tat` no lower than now). */
const GIVE_SQL = `UPDATE rate_limit_buckets SET tat = GREATEST(${DB_NOW}, tat - $2::bigint * $3::bigint)
  WHERE user_id = $1`;

const BLOCK_SQL = `INSERT INTO rate_limit_buckets AS b (user_id, tat, blocked_until)
  SELECT $1, 0, n.ms + $2::bigint FROM (SELECT ${DB_NOW} AS ms) AS n
  ON CONFLICT (user_id) DO UPDATE SET blocked_until = GREATEST(b.blocked_until, EXCLUDED.blocked_until)`;

const PEEK_SQL = `SELECT n.ms AS now, b.tat AS tat, b.blocked_until AS blocked_until
  FROM (SELECT ${DB_NOW} AS ms) AS n LEFT JOIN rate_limit_buckets AS b ON b.user_id = $1`;

/**
 * The write admission, in one statement under the row's lock: prune the
 * admissions older than the window, then admit (append now) while fewer than
 * the limit remain. Parameters: $1 user, $2 the limit, $3 the window.
 *
 * `n.ms` is the statement's start, taken before it waits for the row lock, so
 * an admission that waited can commit after a later-starting one. The stored
 * times are only ever read as a set (pruned, counted, the oldest found by
 * sorting), and `last_admitted_at`, the sweep's clock, never moves back, so a
 * row is never swept while a newer admission is in the window.
 */
const ADMIT_WRITE_SQL = `UPDATE rate_limit_writes AS t SET
    admitted = CASE WHEN cardinality(k.kept) < $2::int THEN k.kept || n.ms ELSE k.kept END,
    refused_since_admit = (cardinality(k.kept) >= $2::int),
    last_admitted_at = CASE WHEN cardinality(k.kept) < $2::int THEN GREATEST(o.last_admitted_at, n.ms) ELSE o.last_admitted_at END
  FROM (SELECT admitted, refused_since_admit, last_admitted_at FROM rate_limit_writes WHERE user_id = $1 FOR UPDATE) AS o
    CROSS JOIN (SELECT ${DB_NOW} AS ms) AS n
    CROSS JOIN LATERAL (
      SELECT COALESCE(array_agg(a ORDER BY a), '{}'::bigint[]) AS kept
      FROM unnest(o.admitted) AS a WHERE a > n.ms - $3::bigint
    ) AS k
  WHERE t.user_id = $1
  RETURNING (cardinality(k.kept) < $2::int) AS allowed, o.refused_since_admit AS was_refused,
    k.kept[1] AS oldest, n.ms AS now`;

const CREATE_WRITES_SQL =
  "INSERT INTO rate_limit_writes (user_id, admitted, refused_since_admit, last_admitted_at) VALUES ($1, '{}', FALSE, 0) ON CONFLICT (user_id) DO NOTHING";

/** Remove one occurrence of an admission time (two writes may share a millisecond). */
const RELEASE_WRITE_SQL = `UPDATE rate_limit_writes SET admitted =
    admitted[:array_position(admitted, $2::bigint) - 1] || admitted[array_position(admitted, $2::bigint) + 1:]
  WHERE user_id = $1 AND array_position(admitted, $2::bigint) IS NOT NULL`;

/** Rows a sweep batch deletes at most. */
export const RATE_LIMIT_SWEEP_BATCH = 1000;

/** What one sweep of the rate-limit tables deleted. */
export interface RateLimitSweepCounts {
  /** Windows that have ended. */
  rateLimitWindows: number;
  /** Full, unblocked buckets: the same as no row. */
  rateLimitBuckets: number;
  /** Write-cap rows with no admission left in the window: the same as no row. */
  rateLimitWrites: number;
}

/**
 * The sweep's DELETEs, batched (`$1` the batch size; on SQLite `$1` is the
 * clock and `$2` the batch). On Postgres the clock is the database's and a
 * batch skips rows a limiter holds (SKIP LOCKED).
 */
export function rateLimitSweepSql(dialect: Dialect): { windows: string; buckets: string; writes: string } {
  if (dialect === 'postgres') {
    return {
      writes: `DELETE FROM rate_limit_writes WHERE user_id IN (
        SELECT user_id FROM rate_limit_writes WHERE last_admitted_at <= ${DB_NOW} - ${SHARED_WRITE_WINDOW_MS}
        LIMIT $1 FOR UPDATE SKIP LOCKED)`,
      windows: `DELETE FROM rate_limit_hits WHERE (limiter, key) IN (
        SELECT limiter, key FROM rate_limit_hits WHERE reset_at <= ${DB_NOW} LIMIT $1 FOR UPDATE SKIP LOCKED)`,
      buckets: `DELETE FROM rate_limit_buckets WHERE user_id IN (
        SELECT user_id FROM rate_limit_buckets WHERE tat <= ${DB_NOW} AND blocked_until <= ${DB_NOW}
        LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    };
  }
  return {
    writes: `DELETE FROM rate_limit_writes WHERE user_id IN (
      SELECT user_id FROM rate_limit_writes WHERE last_admitted_at <= $1 LIMIT $2)`,
    windows: `DELETE FROM rate_limit_hits WHERE rowid IN (
      SELECT rowid FROM rate_limit_hits WHERE reset_at <= $1 LIMIT $2)`,
    buckets: `DELETE FROM rate_limit_buckets WHERE user_id IN (
      SELECT user_id FROM rate_limit_buckets WHERE tat <= $1 AND blocked_until <= $2 LIMIT $3)`,
  };
}

/** Run the sweep in batches through `run` (returns rows deleted). */
export async function runRateLimitSweep(
  dialect: Dialect,
  run: (sql: string, params: unknown[]) => Promise<number>,
  now: number,
  batchSize: number = RATE_LIMIT_SWEEP_BATCH
): Promise<RateLimitSweepCounts> {
  const sql = rateLimitSweepSql(dialect);
  const counts: RateLimitSweepCounts = { rateLimitWindows: 0, rateLimitBuckets: 0, rateLimitWrites: 0 };
  const batches: Array<[keyof RateLimitSweepCounts, string, unknown[]]> = [
    ['rateLimitWindows', sql.windows, dialect === 'postgres' ? [batchSize] : [now, batchSize]],
    ['rateLimitBuckets', sql.buckets, dialect === 'postgres' ? [batchSize] : [now, now, batchSize]],
    ['rateLimitWrites', sql.writes, dialect === 'postgres' ? [batchSize] : [now - SHARED_WRITE_WINDOW_MS, batchSize]],
  ];
  for (const [counter, text, params] of batches) {
    for (;;) {
      const deleted = await run(text, params);
      counts[counter] += deleted;
      if (deleted < batchSize) break;
    }
  }
  return counts;
}

/** How often an unavailable store is logged at most. */
const REPORT_INTERVAL_MS = 30_000;

/**
 * {@link SharedLimitStore} on Postgres, over a pool of its own with short time
 * bounds (src/storage/timeouts.ts), so a limiter never waits behind the
 * storage pool and never longer than those bounds. `pool.query` hands a
 * connection whose query timed out back as broken, so it isn't reused.
 */
export class PostgresSharedLimits implements SharedLimitStore {
  private lastReportAt = -Infinity;

  constructor(
    private readonly pool: PgPool,
    private readonly keys: LimiterKeyDeriver
  ) {}

  private digest(limiter: string, key: string): string {
    return this.keys.limiterKey(limiter, key);
  }

  async hit(limiter: string, key: string, windowMs: number): Promise<WindowHits> {
    const rows = await this.query<{ hits: string; reset_at: string }>(HIT_SQL, [limiter, this.digest(limiter, key), windowMs]);
    const row = rows[0];
    if (!row) throw this.unavailable(new Error('rate_limit_hits upsert returned no row'));
    return { hits: Number(row.hits), resetAt: Number(row.reset_at) };
  }

  async unhit(limiter: string, key: string): Promise<void> {
    await this.query(UNHIT_SQL, [limiter, this.digest(limiter, key)]);
  }

  async resetHits(limiter: string, key: string): Promise<void> {
    await this.query(RESET_HITS_SQL, [limiter, this.digest(limiter, key)]);
  }

  async getHits(limiter: string, key: string): Promise<WindowHits | undefined> {
    const rows = await this.query<{ hits: string; reset_at: string }>(GET_HITS_SQL, [limiter, this.digest(limiter, key)]);
    const row = rows[0];
    return row ? { hits: Number(row.hits), resetAt: Number(row.reset_at) } : undefined;
  }

  async take(userId: string, count: number, shape: BucketShape, maxDebtMs: number): Promise<BucketState> {
    const params = [userId, count, shape.intervalMs, shape.burstMs, Math.max(0, Math.floor(maxDebtMs))];
    // A missing row is a full bucket: create it and take again. The sweep may
    // delete a full row in between, hence a few tries.
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await this.query<{ previous_tat: string; tat: string; blocked_until: string; now: string }>(TAKE_SQL, params);
      const row = rows[0];
      if (row) {
        return {
          previousTat: Number(row.previous_tat),
          tat: Number(row.tat),
          blockedUntil: Number(row.blocked_until),
          now: Number(row.now),
        };
      }
      await this.query(CREATE_BUCKET_SQL, [userId]);
    }
    throw this.unavailable(new Error('rate_limit_buckets row kept disappearing'));
  }

  async give(userId: string, count: number, shape: BucketShape): Promise<void> {
    await this.query(GIVE_SQL, [userId, count, shape.intervalMs]);
  }

  async block(userId: string, windowMs: number): Promise<void> {
    await this.query(BLOCK_SQL, [userId, Math.max(0, Math.ceil(windowMs))]);
  }

  async peek(userId: string): Promise<BucketState> {
    const rows = await this.query<{ now: string; tat: string | null; blocked_until: string | null }>(PEEK_SQL, [userId]);
    const row = rows[0];
    if (!row) throw this.unavailable(new Error('rate_limit_buckets peek returned no row'));
    const now = Number(row.now);
    const tat = row.tat === null ? 0 : Number(row.tat);
    return { previousTat: tat, tat, blockedUntil: row.blocked_until === null ? 0 : Number(row.blocked_until), now };
  }

  async admitWrite(userId: string, limit: number, windowMs: number): Promise<WriteCapState> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await this.query<{ allowed: boolean; was_refused: boolean; oldest: string | null; now: string }>(
        ADMIT_WRITE_SQL,
        [userId, limit, windowMs]
      );
      const row = rows[0];
      if (row) {
        const now = Number(row.now);
        return {
          allowed: row.allowed,
          firstRefusal: !row.allowed && !row.was_refused,
          resetsAt: row.oldest === null ? now : Number(row.oldest) + windowMs,
          now,
        };
      }
      await this.query(CREATE_WRITES_SQL, [userId]);
    }
    throw this.unavailable(new Error('rate_limit_writes row kept disappearing'));
  }

  async releaseWrite(userId: string, admittedAt: number): Promise<void> {
    await this.query(RELEASE_WRITE_SQL, [userId, admittedAt]);
  }

  private async query<T extends object>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return (await this.pool.query<T & Record<string, unknown>>(sql, params)).rows;
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): SharedLimitUnavailableError {
    if (error instanceof SharedLimitUnavailableError) return error;
    const now = Date.now();
    if (now - this.lastReportAt >= REPORT_INTERVAL_MS) {
      this.lastReportAt = now;
      console.error(
        '[RateLimit] the shared rate-limit store (RATE_LIMIT_STORE=postgres) is unavailable; refusing requests until it answers:',
        sanitizeErrorMessage(error)
      );
    }
    return new SharedLimitUnavailableError();
  }
}
