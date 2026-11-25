/**
 * #67 (schema 8): the shared rate-limit tables and the Postgres store behind
 * RATE_LIMIT_STORE=postgres. Two replicas are two PostgresStorage instances
 * on one database (each with its own limiter pool), as two processes would
 * be: the AS windows and the per-user YNAB bucket are counted once between
 * them, atomically; a fan-out is all or nothing; the waiter is one per user
 * across replicas; a YNAB 429 pauses both; the sweep and the account erase
 * remove rows; and a database that doesn't answer fails closed within the
 * limiter pool's bounds. The migration from schema 7 runs on SQLite and
 * Postgres and is idempotent.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { SCHEMA_VERSION } from '../../../src/storage/migrations.js';
import {
  PostgresSharedLimits,
  RATE_LIMIT_BUCKETS_TABLE,
  RATE_LIMIT_HITS_TABLE,
  RATE_LIMIT_WRITES_TABLE,
  SHARED_WRITE_WINDOW_MS,
  type SharedLimitStore,
} from '../../../src/storage/shared-limits.js';
import { TokenHasher } from '../../../src/auth/token-hash.js';
import { TEST_TOKEN_HASHER } from '../helpers/token-hasher.js';
import { SharedWriteLimiter } from '../../../src/services/shared-write-limiter.js';
import { WRITE_WINDOW_MS } from '../../../src/services/write-limiter.js';
import { USER_DATA_TABLES } from '../../../src/storage/user-data.js';
import { SharedRateLimiter } from '../../../src/services/shared-rate-limiter.js';
import { SharedWindowStore } from '../../../src/middleware/shared-limiter-store.js';
import { RateLimitError, RateLimitStoreUnavailableError } from '../../../src/utils/errors.js';
import type { Storage } from '../../../src/storage/types.js';
import type { Options } from 'express-rate-limit';
import { runSweepPass, SWEEP_STEPS } from '../../../src/auth/sweep-job.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

type Sql = NonNullable<DriverHandle['sql']>;

describe('schema 8 (M7)', () => {
  it('is the current schema, and the bucket and write-cap tables are in the account erase', () => {
    expect(SCHEMA_VERSION).toBe(8);
    expect(USER_DATA_TABLES.slice(-2)).toEqual([
      { table: 'rate_limit_buckets', column: 'user_id' },
      { table: 'rate_limit_writes', column: 'user_id' },
    ]);
    expect(SHARED_WRITE_WINDOW_MS).toBe(WRITE_WINDOW_MS);
    for (const table of [RATE_LIMIT_HITS_TABLE, RATE_LIMIT_BUCKETS_TABLE, RATE_LIMIT_WRITES_TABLE]) {
      expect(Object.keys(table.sql).sort()).toEqual(['postgres', 'sqlite']);
    }
  });

  it('stores a limiter key as an HMAC under the pepper: per limiter, the same on every replica, not a plain hash', () => {
    const key = 'ip:203.0.113.5';
    const digest = TEST_TOKEN_HASHER.limiterKey('route:token:ip', key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Every replica has the pepper, so they agree.
    expect(TokenHasher.fromSecrets({ tokenPepper: Buffer.alloc(32, 7).toString('base64') }).limiterKey('route:token:ip', key)).toBe(
      new TokenHasher(Buffer.alloc(32, 7)).limiterKey('route:token:ip', key)
    );
    // Another pepper, another limiter: another digest; and no unkeyed SHA-256 of the key.
    expect(new TokenHasher(Buffer.alloc(32, 9)).limiterKey('route:token:ip', key)).not.toBe(digest);
    expect(TEST_TOKEN_HASHER.limiterKey('authorize:ip', key)).not.toBe(digest);
    expect(digest).not.toBe(createHash('sha256').update(key).digest('hex'));
    expect(digest).not.toBe(createHash('sha256').update(`route:token:ip\0${key}`).digest('hex'));
  });
});

for (const driver of testDrivers.filter((d) => d.kind !== 'memory')) {
  describe.skipIf(!driver.enabled)(`schema 8 migration: ${driver.name}`, () => {
    it('upgrades a schema 7 database: both tables and their indexes are created, the stamp is 8, a restart changes nothing', async () => {
      const h = await driver.open();
      const sql = h.sql as Sql;
      await h.storage.upsertUser({ userId: 'u1', grantedScope: 'read-only', encryptedRefreshToken: 'enc-u1', updatedAt: Date.now() });
      // As schema 7 left it: no rate-limit tables, stamped 7.
      await sql('DROP TABLE rate_limit_hits');
      await sql('DROP TABLE rate_limit_buckets');
      await sql('DROP TABLE rate_limit_writes');
      await sql("UPDATE schema_meta SET value = '7' WHERE key = 'schema_version'");
      expect(await tableExists(h, 'rate_limit_hits')).toBe(false);

      const upgraded = await h.reopen();
      expect(await tableExists(h, 'rate_limit_hits')).toBe(true);
      expect(await tableExists(h, 'rate_limit_buckets')).toBe(true);
      expect(await tableExists(h, 'rate_limit_writes')).toBe(true);
      expect((await indexes(h, 'rate_limit_writes')).filter((n) => n.endsWith('_last_admitted_at'))).toEqual([
        'rate_limit_writes_last_admitted_at',
      ]);
      expect((await indexes(h, 'rate_limit_hits')).filter((n) => n.endsWith('_reset_at'))).toEqual(['rate_limit_hits_reset_at']);
      expect((await indexes(h, 'rate_limit_buckets')).filter((n) => n.endsWith('_tat'))).toEqual(['rate_limit_buckets_tat']);
      expect(await schemaVersion(sql)).toBe('8');
      expect(await upgraded.getUser('u1')).toBeDefined();
      expect(await upgraded.sweepRateLimitRows()).toEqual({ rateLimitWindows: 0, rateLimitBuckets: 0, rateLimitWrites: 0 });

      // A restart against the upgraded database (rows in both tables) changes nothing.
      await sql("INSERT INTO rate_limit_hits (limiter, key, hits, reset_at) VALUES ('l', 'k', 3, 99999999999999)");
      await sql("INSERT INTO rate_limit_buckets (user_id, tat, blocked_until) VALUES ('u1', 99999999999999, 0)");
      const again = await h.reopen();
      expect(await schemaVersion(sql)).toBe('8');
      expect(await sql('SELECT hits FROM rate_limit_hits')).toEqual([{ hits: driver.kind === 'postgres' ? '3' : 3 }]);
      expect(await again.getUser('u1')).toBeDefined();
    });

    it('the sweep removes ended windows, full unblocked buckets and spent write caps only; the erase removes the user\'s rows', async () => {
      const h = await driver.open();
      const sql = h.sql as Sql;
      const past = 1_000;
      const future = Date.now() + 3_600_000;
      await sql(
        `INSERT INTO rate_limit_hits (limiter, key, hits, reset_at) VALUES ('l', 'ended', 5, ${past}), ('l', 'live', 5, ${future})`
      );
      await sql(
        `INSERT INTO rate_limit_buckets (user_id, tat, blocked_until) VALUES
          ('full', ${past}, 0), ('draining', ${future}, 0), ('blocked', ${past}, ${future}), ('u1', ${future}, 0), ('u2', ${future}, 0)`
      );
      // A write cap last used over an hour ago limits nothing; one used now does.
      const empty = driver.kind === 'postgres' ? "'{}'" : "'[]'";
      await sql(
        `INSERT INTO rate_limit_writes (user_id, admitted, last_admitted_at) VALUES
          ('idle-writer', ${empty}, ${past}), ('u1', ${empty}, ${Date.now()}), ('u2', ${empty}, ${Date.now()})`
      );
      expect(await h.storage.sweepRateLimitRows()).toEqual({ rateLimitWindows: 1, rateLimitBuckets: 1, rateLimitWrites: 1 });
      expect((await sql('SELECT key FROM rate_limit_hits')).map((r) => r['key'])).toEqual(['live']);
      expect((await sql('SELECT user_id FROM rate_limit_buckets ORDER BY user_id')).map((r) => r['user_id'])).toEqual([
        'blocked',
        'draining',
        'u1',
        'u2',
      ]);

      await h.storage.upsertUser({ userId: 'u1', grantedScope: 'read-only', encryptedRefreshToken: 'enc-u1', updatedAt: Date.now() });
      expect(await h.storage.deleteUserData('u1')).toBe(true);
      expect((await sql('SELECT user_id FROM rate_limit_buckets ORDER BY user_id')).map((r) => r['user_id'])).toEqual([
        'blocked',
        'draining',
        'u2',
      ]);
      expect((await sql('SELECT user_id FROM rate_limit_writes')).map((r) => r['user_id'])).toEqual(['u2']);
    });

    it('the sweep job runs the step on the real driver and logs counts only', async () => {
      const h = await driver.open();
      const sql = h.sql as Sql;
      await sql("INSERT INTO rate_limit_hits (limiter, key, hits, reset_at) VALUES ('l', 'ended', 5, 1000)");
      await sql("INSERT INTO rate_limit_buckets (user_id, tat, blocked_until) VALUES ('full-user', 1000, 0)");
      const log = vi.fn();
      const step = SWEEP_STEPS.find((s) => s.name === 'rate-limit-rows')!;
      const empty = driver.kind === 'postgres' ? "'{}'" : "'[]'";
      await sql(`INSERT INTO rate_limit_writes (user_id, admitted, last_admitted_at) VALUES ('idle-writer', ${empty}, 1000)`);
      expect(await runSweepPass(h.storage, { steps: [step], log })).toEqual({ deleted: 3, failed: 0 });
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
        '[Sweep] rate-limit-rows: deleted rateLimitWindows=1 rateLimitBuckets=1 rateLimitWrites=1',
      ]);
    });
  });
}

const postgres = testDrivers.find((d) => d.kind === 'postgres')!;

/** Two replicas on one database: each storage has its own pools. */
async function twoReplicas(): Promise<{ h: DriverHandle; a: Storage; b: Storage; sql: Sql }> {
  const h = await postgres.open();
  const b = await h.reopen();
  return { h, a: h.storage, b, sql: h.sql as Sql };
}

function limiter(storage: Storage, userId: string, perHour: number, maxWaitMs = 0): SharedRateLimiter {
  return new SharedRateLimiter(storage.sharedLimits!(), userId, perHour, Date.now, maxWaitMs);
}

function windowStore(storage: Storage, name: string, windowMs = 60_000): SharedWindowStore {
  const store = new SharedWindowStore(storage.sharedLimits!(), name);
  store.init({ windowMs } as Options);
  return store;
}

/** Settle every promise; count fulfilled ones and collect the rejections. */
async function settle<T>(promises: Array<Promise<T>>): Promise<{ ok: T[]; errors: unknown[] }> {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    errors: results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : [])),
  };
}

describe.skipIf(!postgres.enabled)('shared limits across two replicas (Postgres)', () => {
  it('an AS limiter window is one count across replicas, atomic under concurrency, namespaced by limiter', async () => {
    const { a, b, sql } = await twoReplicas();
    const onA = windowStore(a, 'route:token:ip');
    const onB = windowStore(b, 'route:token:ip');
    const hits = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? onA : onB).increment('ip:203.0.113.5'))
    );
    expect(hits.map((h) => h.totalHits).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    // One window: every hit reports the same reset time.
    expect(new Set(hits.map((h) => h.resetTime?.getTime())).size).toBe(1);
    // Another limiter, or another key, has its own window.
    expect((await windowStore(a, 'authorize:ip').increment('ip:203.0.113.5')).totalHits).toBe(1);
    expect((await onB.increment('ip:198.51.100.7')).totalHits).toBe(1);
    // No raw address in the table: the key is the pepper-keyed digest.
    expect(JSON.stringify(await sql('SELECT * FROM rate_limit_hits'))).not.toContain('203.0.113.5');
    const keys = (await sql("SELECT key FROM rate_limit_hits WHERE limiter = 'route:token:ip'")).map((r) => r['key']);
    expect(keys.sort()).toEqual(
      ['ip:203.0.113.5', 'ip:198.51.100.7'].map((k) => TEST_TOKEN_HASHER.limiterKey('route:token:ip', k)).sort()
    );
    // decrement, get, resetKey
    await onA.decrement('ip:203.0.113.5');
    expect((await onB.get('ip:203.0.113.5'))?.totalHits).toBe(39);
    await onB.resetKey('ip:203.0.113.5');
    expect(await onA.get('ip:203.0.113.5')).toBeUndefined();
    expect((await onA.increment('ip:203.0.113.5')).totalHits).toBe(1);
  });

  it('a window that has ended starts again at 1', async () => {
    const { a, b, sql } = await twoReplicas();
    await windowStore(a, 'oauth-leg').increment('ip:x');
    await windowStore(b, 'oauth-leg').increment('ip:x');
    await sql('UPDATE rate_limit_hits SET reset_at = 1000');
    const next = await windowStore(b, 'oauth-leg', 900_000).increment('ip:x');
    expect(next.totalHits).toBe(1);
    expect(next.resetTime!.getTime()).toBeGreaterThan(Date.now() + 890_000);
  });

  it('the YNAB budget is one budget: two replicas spend RATE_LIMIT_PER_HOUR between them, not each', async () => {
    const { a, b } = await twoReplicas();
    const onA = limiter(a, 'u1', 10);
    const onB = limiter(b, 'u1', 10);
    const { ok, errors } = await settle(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? onA : onB).acquire()));
    expect(ok).toHaveLength(10);
    expect(errors).toHaveLength(20);
    for (const e of errors) expect(e).toBeInstanceOf(RateLimitError);
    // Each refusal says when the next token is free: about 6 minutes at 10 an hour.
    for (const e of errors) expect((e as RateLimitError).retryAfterMs).toBeGreaterThan(350_000);
    for (const e of errors) expect((e as RateLimitError).retryAfterMs).toBeLessThanOrEqual(360_000);
    // Another user has their own budget.
    await expect(limiter(b, 'u2', 10).acquire()).resolves.toBeUndefined();
    // Both replicas report the shared state.
    await onA.refresh();
    expect(onA.getStatus()).toMatchObject({ available: 0, limit: 10, store: 'postgres' });
  });

  it('a fan-out reservation is all or none, atomically across replicas', async () => {
    const { a, b } = await twoReplicas();
    const onA = limiter(a, 'u1', 10);
    const onB = limiter(b, 'u1', 10);
    const { ok, errors } = await settle(Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? onA : onB).acquireMany(4)));
    expect(ok).toEqual([4, 4]);
    expect(errors).toHaveLength(4);
    // 2 tokens left: 3 is refused (whole), 2 is taken.
    await expect(onA.acquireMany(3)).rejects.toBeInstanceOf(RateLimitError);
    expect(await onB.acquireMany(2)).toBe(2);
    await expect(onA.acquire()).rejects.toBeInstanceOf(RateLimitError);
    // More than the bucket holds is refused, with the time until it is full.
    const tooMany = await onB.acquireMany(11).catch((e: unknown) => e);
    expect(tooMany).toBeInstanceOf(RateLimitError);
    expect((tooMany as RateLimitError).retryAfterMs).toBeGreaterThan(3_590_000);
    expect((tooMany as RateLimitError).retryAfterMs).toBeLessThanOrEqual(3_600_000);
  });

  it('fail fast: the retry time is the time until a token is free, and a token given back on one replica serves the other', async () => {
    const { a, b, sql } = await twoReplicas();
    const onA = limiter(a, 'u1', 3);
    const onB = limiter(b, 'u1', 3);
    await onA.acquire();
    await onB.acquire();
    await onA.acquire();
    const refused = await onB.acquire().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RateLimitError);
    // 3 an hour: a token every 20 minutes, the first one 20 minutes after the bucket started draining.
    expect((refused as RateLimitError).retryAfterMs).toBeGreaterThan(1_190_000);
    expect((refused as RateLimitError).retryAfterMs).toBeLessThanOrEqual(1_200_000);
    onA.release(1);
    await vi.waitFor(async () => {
      const [row] = await sql('SELECT tat FROM rate_limit_buckets');
      expect(Number(row?.['tat']) - Date.now()).toBeLessThan(2_400_000 + 1_000);
    });
    await expect(onB.acquire()).resolves.toBeUndefined();
  });

  it('the waiter cap: one caller per user waits for its token, on any replica; the next is refused with the time after it', async () => {
    const { a, b } = await twoReplicas();
    // 7,200 an hour: a token every 500 ms (wide enough that the two calls land
    // within one interval on a loaded runner). Drain the bucket in one reservation.
    const onA = limiter(a, 'u1', 7_200, 2_000);
    const onB = limiter(b, 'u1', 7_200, 2_000);
    expect(await onA.acquireMany(7_200)).toBe(7_200);
    const startedAt = Date.now();
    const [first, second] = await Promise.allSettled([onA.acquire(), onB.acquire()]);
    const outcomes = [first, second];
    const waited = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(waited).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(RateLimitError);
    // The refused caller's token comes after the waiter's: about a second out.
    const retry = (refused[0]!.reason as RateLimitError).retryAfterMs!;
    expect(retry).toBeGreaterThan(500);
    expect(retry).toBeLessThanOrEqual(1_000);
    // The waiter slept for its token.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    // RATE_LIMIT_MAX_WAIT_MS=0 never waits, and a wait longer than the cap is refused.
    await expect(limiter(b, 'u1', 7_200, 0).acquire()).rejects.toBeInstanceOf(RateLimitError);
    await expect(limiter(b, 'u1', 7_200, 10).acquire()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("YNAB's 429 on one replica pauses the user's requests on the other", async () => {
    const { a, b, sql } = await twoReplicas();
    const onA = limiter(a, 'u1', 180);
    const onB = limiter(b, 'u1', 180);
    await onA.acquire();
    expect(onA.markExhaustedByYnab(60_000)).toBe(60_000);
    await expect(onA.acquire()).rejects.toBeInstanceOf(RateLimitError);
    await vi.waitFor(async () => {
      const [row] = await sql('SELECT blocked_until FROM rate_limit_buckets');
      expect(Number(row?.['blocked_until'])).toBeGreaterThan(Date.now());
    });
    const refused = await onB.acquire().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RateLimitError);
    expect((refused as RateLimitError).retryAfterMs).toBeGreaterThan(55_000);
    // From then on B refuses locally too, and reports it.
    expect(onB.getStatus().ynabExhausted?.active).toBe(true);
    await expect(onB.acquireMany(2)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('the write cap is one cap: two replicas admit exactly the limit between them, atomically', async () => {
    const { a, b, sql } = await twoReplicas();
    const onA = new SharedWriteLimiter(a.sharedLimits!(), 'u1', 5);
    const onB = new SharedWriteLimiter(b.sharedLimits!(), 'u1', 5);
    const admissions = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? onA : onB).tryAcquire()));
    const allowed = admissions.filter((x) => x.allowed);
    const refused = admissions.filter((x): x is Extract<typeof x, { allowed: false }> => !x.allowed);
    expect(allowed).toHaveLength(5);
    expect(refused).toHaveLength(15);
    // The first refusal of the episode is flagged once, across both replicas (the one #60a audits).
    expect(refused.filter((r) => r.firstRefusal)).toHaveLength(1);
    for (const r of refused) {
      expect(r.limit).toBe(5);
      // Sliding window: the next write when the oldest admission is an hour old.
      expect(r.retryAfterMs).toBeGreaterThan(3_590_000);
      expect(r.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    }
    // Another user has their own cap.
    expect((await new SharedWriteLimiter(b.sharedLimits!(), 'u2', 5).tryAcquire()).allowed).toBe(true);

    // A released slot (a call that failed input validation) is free on the other replica.
    (allowed[0] as Extract<(typeof admissions)[number], { allowed: true }>).release();
    await vi.waitFor(async () => {
      const [row] = await sql("SELECT cardinality(admitted) AS n FROM rate_limit_writes WHERE user_id = 'u1'");
      expect(Number(row?.['n'])).toBe(4);
    });
    expect((await onB.tryAcquire()).allowed).toBe(true);
    const again = await onA.tryAcquire();
    expect(again.allowed).toBe(false);
    // A new episode after an admission: its first refusal is flagged again.
    expect(again.allowed === false && again.firstRefusal).toBe(true);

    // The window slides: admissions older than an hour no longer count.
    await sql(`UPDATE rate_limit_writes SET admitted = ARRAY[1000, 2000, 3000, 4000]::bigint[] || admitted[5:5] WHERE user_id = 'u1'`);
    const after = await Promise.all([onA.tryAcquire(), onB.tryAcquire(), onA.tryAcquire(), onB.tryAcquire(), onA.tryAcquire()]);
    expect(after.filter((x) => x.allowed)).toHaveLength(4);
    // A cap of 0 is off and never reads the database.
    expect((await new SharedWriteLimiter(a.sharedLimits!(), 'u1', 0).tryAcquire()).allowed).toBe(true);
  });

  it('fails closed, within the limiter bounds, when the tables are locked; works again once they are free', async () => {
    const h = await postgres.open({ timeouts: { pgLimiterStatementTimeoutMs: 200, pgLimiterQueryTimeoutMs: 1_000 } });
    const pg = (await import('pg')).default;
    const locker = new pg.Client({ connectionString: h.connectionString });
    await locker.connect();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bucket = limiter(h.storage, 'u1', 180);
      const window = windowStore(h.storage, 'authorize:ip');
      await bucket.acquire();
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE rate_limit_buckets, rate_limit_hits, rate_limit_writes IN ACCESS EXCLUSIVE MODE');

      const startedAt = Date.now();
      await expect(new SharedWriteLimiter(h.storage.sharedLimits!(), 'u1', 20).tryAcquire()).rejects.toBeInstanceOf(
        RateLimitStoreUnavailableError
      );
      const refused = await bucket.acquire().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RateLimitStoreUnavailableError);
      expect((refused as RateLimitStoreUnavailableError).retryAfterMs).toBe(5_000);
      await expect(bucket.acquireMany(3)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
      // The AS window counts as over every limit, with a short window.
      const over = await window.increment('ip:x');
      expect(over.totalHits).toBe(Number.MAX_SAFE_INTEGER);
      expect(over.resetTime!.getTime() - Date.now()).toBeLessThanOrEqual(5_000);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      // Logged once (rate limited), without values.
      const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('[RateLimit]'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/statement timeout/);

      await locker.query('ROLLBACK');
      await expect(bucket.acquire()).resolves.toBeUndefined();
      expect((await window.increment('ip:x')).totalHits).toBe(1);
    } finally {
      await locker.end();
    }
  });

  it('fails closed when the database is unreachable', async () => {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store: SharedLimitStore = new PostgresSharedLimits(pool, TEST_TOKEN_HASHER);
      const bucket = new SharedRateLimiter(store, 'u1', 180);
      const startedAt = Date.now();
      await expect(bucket.acquire()).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
      await expect(bucket.acquireMany(2)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
      const window = new SharedWindowStore(store, 'register:ip');
      expect((await window.increment('ip:x')).totalHits).toBe(Number.MAX_SAFE_INTEGER);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      // Never a local budget: still refused.
      await expect(bucket.acquire()).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
      expect(bucket.getStatus().sentLastHour).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

async function schemaVersion(sql: Sql): Promise<unknown> {
  return (await sql("SELECT value FROM schema_meta WHERE key = 'schema_version'"))[0]?.['value'];
}

async function tableExists(h: DriverHandle, table: string): Promise<boolean> {
  const sql = h.sql as Sql;
  if (h.kind === 'sqlite') {
    return (await sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1", [table])).length === 1;
  }
  return (await sql('SELECT to_regclass($1) IS NOT NULL AS present', [table]))[0]?.['present'] === true;
}

async function indexes(h: DriverHandle, table: string): Promise<string[]> {
  const sql = h.sql as Sql;
  if (h.kind === 'sqlite') {
    return (await sql("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = $1 AND sql IS NOT NULL", [table])).map((r) =>
      String(r['name'])
    );
  }
  return (await sql('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1', [table])).map((r) =>
    String(r['indexname'])
  );
}
