/**
 * Races in the oauth_rows writers that need a controlled interleaving:
 *
 *   - a staged sign-in's expiry is judged on the clock read after the write
 *     lock is held, not before waiting for it (SQLite and Postgres).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Storage, OAuthRowStore, OAuthRowWrite } from '../../../src/storage/types.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { TEST_TOKEN_HASHER } from '../helpers/token-hasher.js';

type Store = Storage & OAuthRowStore;

const blank = { payload: '{}', grantId: undefined, accountId: undefined, clientId: undefined, uid: undefined, expiresAt: undefined };

/** A client, a grant for `userId`, and a sign-in staged for `ttlMs`; returns the code row to save. */
async function stagedSignIn(store: Store, userId: string, ttlMs: number): Promise<OAuthRowWrite> {
  const clientId = `c-${randomUUID()}`;
  const grantId = `g-${randomUUID()}`;
  await store.upsertOAuthRow({ ...blank, key: plainRowKey('Client', clientId), model: 'Client', clientId });
  await store.upsertOAuthRow({
    ...blank,
    key: plainRowKey('Grant', grantId),
    model: 'Grant',
    grantId,
    accountId: userId,
    clientId,
    expiresAt: Date.now() + 3_600_000,
  });
  const staged = await store.stageSignIn({
    grantId,
    user: { userId, grantedScope: 'read-only', encryptedRefreshToken: 'enc', updatedAt: Date.now() },
    expiresAt: Date.now() + ttlMs,
  });
  expect(staged).toBe(true);
  return {
    ...blank,
    key: `h1.${randomUUID()}`,
    model: 'AuthorizationCode',
    grantId,
    accountId: userId,
    clientId,
    expiresAt: Date.now() + 600_000,
  };
}

/** Date.now() plus an offset the test moves, so a wait can "take" longer than the sign-in's life. */
function skewedClock(extra: () => number): void {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + extra());
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

const sqliteDriver = testDrivers.find((d) => d.kind === 'sqlite');
const pgDriver = testDrivers.find((d) => d.kind === 'postgres');

describe.skipIf(!sqliteDriver?.enabled)('SqliteStorage: the clock is read under the write lock', () => {
  it('judges the staged sign-in at the time BEGIN IMMEDIATE returned', async () => {
    const h = await (sqliteDriver as NonNullable<typeof sqliteDriver>).open();
    const store = h.storage as Store;
    const code = await stagedSignIn(store, 'u1', 60_000);
    const db = (store as unknown as { database: { inTransaction: boolean } }).database;
    // Time passes only once the transaction has begun: as when BEGIN IMMEDIATE waited for another process's lock.
    skewedClock(() => (db.inTransaction ? 120_000 : 0));
    expect(await store.saveAuthorizationCode(code)).toBe('no-sign-in');
  });
});

describe.skipIf(!pgDriver?.enabled)('PostgresStorage: lock waits', () => {
  async function replica(h: DriverHandle): Promise<{ storage: Store; app: string }> {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const app = `races-${randomUUID().slice(0, 8)}`;
    const url = new URL(h.connectionString as string);
    url.searchParams.set('application_name', app);
    const storage = new PostgresStorage({ connectionString: url.toString(), tokenKeys: TEST_TOKEN_HASHER });
    await storage.init();
    return { storage: storage as Store, app };
  }

  async function rawTx(h: DriverHandle) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: h.connectionString, max: 1 });
    const tx = await pool.connect();
    await tx.query('BEGIN');
    let ended = false;
    return {
      query: (text: string, params?: unknown[]) => tx.query(text, params),
      async end(commit: boolean) {
        if (ended) return;
        ended = true;
        await tx.query(commit ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
        tx.release();
        await pool.end();
      },
    };
  }

  async function waitBlocked(h: DriverHandle, app: string): Promise<void> {
    const sql = h.sql as NonNullable<DriverHandle['sql']>;
    for (let i = 0; i < 400; i++) {
      const rows = await sql(`SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [app]);
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the operation never blocked on a lock');
  }

  it('saveAuthorizationCode judges the staged sign-in after waiting for the account lock', async () => {
    const { LOCK_ACCOUNT } = await import('../../../src/storage/postgres.js');
    const h = await (pgDriver as NonNullable<typeof pgDriver>).open();
    const other = await replica(h);
    const tx = await rawTx(h);
    try {
      const code = await stagedSignIn(h.storage as Store, 'u1', 60_000);
      await tx.query(LOCK_ACCOUNT, ['u1']);
      let waited = 0;
      skewedClock(() => waited);
      const save = other.storage.saveAuthorizationCode(code);
      await waitBlocked(h, other.app);
      waited = 120_000; // the wait outlasted the sign-in
      await tx.end(true);
      expect(await save).toBe('no-sign-in');
    } finally {
      await tx.end(false);
      await other.storage.close();
    }
  });
});
