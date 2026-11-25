/**
 * #60a: the audit log's storage (`audit_log`, schema 7) on every driver: the
 * append, listing and counts, the account-generation guard, the erase with
 * the account (D-7b), and the upgrade from a schema 6 database.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { SCHEMA_VERSION } from '../../../src/storage/migrations.js';
import { AUDIT_LOG_TABLE, MemoryAuditStore, type AuditRecord } from '../../../src/storage/audit-rows.js';
import type { Storage } from '../../../src/storage/types.js';

afterEach(async () => {
  vi.useRealTimers();
  await cleanupDrivers();
});

function row(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: Date.now(),
    userId: 'u1',
    clientId: 'client-a',
    familyId: 'grant-a',
    requestId: 'req-1',
    tool: 'ynab_create_transaction',
    operation: 'create',
    resourceType: 'transaction',
    resourceId: 'txn-1',
    budgetId: 'budget-1',
    outcome: 'success',
    ...overrides,
  };
}

async function seedUser(s: Storage, userId: string): Promise<number> {
  await s.upsertUser({ userId, grantedScope: 'read-write', encryptedRefreshToken: `enc-${userId}`, updatedAt: Date.now() });
  return (await s.getUser(userId))?.createdAt ?? 0;
}

describe('the audit_log table (M6)', () => {
  it('is schema 7, with no column for an amount, a name or a memo', () => {
    expect(SCHEMA_VERSION).toBe(7);
    for (const sql of Object.values(AUDIT_LOG_TABLE.sql)) {
      const columns = [...sql.matchAll(/^\s+(\w+) (?:TEXT|INTEGER|BIGINT|BIGSERIAL)/gm)].map((m) => m[1]);
      expect(columns).toEqual([
        'id',
        'ts',
        'user_id',
        'client_id',
        'family_id',
        'request_id',
        'tool',
        'operation',
        'resource_type',
        'resource_id',
        'budget_id',
        'outcome',
      ]);
    }
  });
});

describe('MemoryAuditStore', () => {
  it('lists by time, newest first, then reverse insertion for equal times, before the limit (as the SQL)', async () => {
    const store = new MemoryAuditStore();
    // Inserted out of time order (a clock step, another replica's row).
    for (const [ts, resourceId] of [[300, 'c'], [100, 'a'], [300, 'd'], [200, 'b'], [50, 'z']] as const) {
      await store.appendAuditEntry(row({ ts, resourceId }));
    }
    expect((await store.listAuditEntries('u1', {}, 10)).map((e) => e.resourceId)).toEqual(['d', 'c', 'b', 'a', 'z']);
    expect((await store.listAuditEntries('u1', {}, 2)).map((e) => e.resourceId)).toEqual(['d', 'c']);
  });

  it("keeps each user's newest entries, bounded per user", async () => {
    const store = new MemoryAuditStore(3);
    for (let i = 0; i < 5; i++) await store.appendAuditEntry(row({ resourceId: `t${i}` }));
    await store.appendAuditEntry(row({ userId: 'u2' }));
    expect((await store.listAuditEntries('u1', {}, 10)).map((e) => e.resourceId)).toEqual(['t4', 't3', 't2']);
    expect(store.countFor('u2')).toBe(1);
    store.deleteUser('u1');
    expect(store.countFor('u1')).toBe(0);
    expect(store.countFor('u2')).toBe(1);
  });
});

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`audit log storage (#60a): ${driver.name}`, () => {
    it('appends and lists newest first, scoped to the user, with every field as written', async () => {
      const h = await driver.open();
      const s = h.storage;
      const t = Date.now();
      await s.appendAuditEntry(row({ ts: t, resourceId: 'first' }));
      await s.appendAuditEntry(row({ ts: t, resourceId: 'second' })); // same ms: insertion order breaks the tie
      await s.appendAuditEntry(row({ ts: t + 1, resourceId: 'third', clientId: undefined, familyId: undefined }));
      await s.appendAuditEntry(row({ userId: 'u2', resourceId: 'other-user' }));

      const listed = await s.listAuditEntries('u1', {}, 10);
      expect(listed.map((e) => e.resourceId)).toEqual(['third', 'second', 'first']);
      expect(listed[2]).toEqual(row({ ts: t, resourceId: 'first' }));
      expect(listed[0]?.clientId).toBeUndefined();
      expect(listed[0]?.familyId).toBeUndefined();
      expect(await s.listAuditEntries('u1', {}, 2)).toHaveLength(2);
      expect((await s.listAuditEntries('u2', {}, 10)).map((e) => e.resourceId)).toEqual(['other-user']);
      expect(await s.listAuditEntries('nobody', {}, 10)).toEqual([]);
    });

    it('filters by operation, resource type, outcomes, time and client, and counts per outcome', async () => {
      const h = await driver.open();
      const s = h.storage;
      const t = Date.now();
      await s.appendAuditEntry(row({ ts: t - 5000, operation: 'update', resourceType: 'category', outcome: 'error' }));
      await s.appendAuditEntry(row({ ts: t, operation: 'create', outcome: 'denied_read_only', clientId: 'client-b' }));
      await s.appendAuditEntry(row({ ts: t, operation: 'create', outcome: 'success' }));
      await s.appendAuditEntry(row({ ts: t, operation: 'delete', outcome: 'denied_scope', tool: undefined, resourceType: undefined }));

      const ids = async (q: Parameters<Storage['listAuditEntries']>[1]) =>
        (await s.listAuditEntries('u1', q, 10)).map((e) => `${e.operation}:${e.outcome}`).sort();
      expect(await ids({ operation: 'create' })).toEqual(['create:denied_read_only', 'create:success']);
      expect(await ids({ resourceType: 'category' })).toEqual(['update:error']);
      expect(await ids({ outcomes: ['denied_scope', 'error'] })).toEqual(['delete:denied_scope', 'update:error']);
      expect(await ids({ outcomes: [] })).toEqual([]);
      expect(await ids({ since: t - 1000 })).toHaveLength(3);
      expect(await ids({ clientId: 'client-b' })).toEqual(['create:denied_read_only']);

      expect(await s.countAuditEntries('u1', {})).toEqual({ error: 1, denied_read_only: 1, success: 1, denied_scope: 1 });
      expect(await s.countAuditEntries('u1', { operation: 'create' })).toEqual({ denied_read_only: 1, success: 1 });
      expect(await s.countAuditEntries('u2', {})).toEqual({});
    });

    it("a guarded entry is written only while the user row of that generation exists", async () => {
      const h = await driver.open();
      const s = h.storage;
      const generation = await seedUser(s, 'u1');
      expect(await s.appendAuditEntry(row(), { generation })).toBe(true);
      // Another generation (the account was erased and connected again since).
      expect(await s.appendAuditEntry(row({ resourceId: 'stale' }), { generation: generation + 1 })).toBe(false);
      // No user row at all.
      expect(await s.appendAuditEntry(row({ userId: 'ghost' }), { generation: 0 })).toBe(false);
      expect((await s.listAuditEntries('u1', {}, 10)).map((e) => e.resourceId)).toEqual(['txn-1']);
      expect(await s.listAuditEntries('ghost', {}, 10)).toEqual([]);
    });

    it("erasing an account erases its audit rows and nobody else's (D-7b); a late write leaves no row", async () => {
      const h = await driver.open();
      const s = h.storage;
      const generation = await seedUser(s, 'u1');
      await seedUser(s, 'u2');
      await s.appendAuditEntry(row(), { generation });
      await s.appendAuditEntry(row({ outcome: 'denied_scope' }));
      await s.appendAuditEntry(row({ userId: 'u2' }));
      await s.deleteUserData('u1');
      expect(await s.listAuditEntries('u1', {}, 10)).toEqual([]);
      expect(await s.listAuditEntries('u2', {}, 10)).toHaveLength(1);
      expect(await rows(h, 'u1')).toBe(0);
      // A write that settles after the erase (its request resolved the old account) writes nothing.
      expect(await s.appendAuditEntry(row(), { generation })).toBe(false);
      expect(await rows(h, 'u1')).toBe(0);
    });

    if (driver.kind === 'postgres') {
      it('a guarded write racing an erase on another replica waits for it and writes nothing', async () => {
        const h = await driver.open();
        const generation = await seedUser(h.storage, 'u1');
        const pg = (await import('pg')).default;
        const eraser = new pg.Client({ connectionString: h.connectionString });
        await eraser.connect();
        try {
          // An erase in flight: the user row deleted, not yet committed.
          await eraser.query('BEGIN');
          await eraser.query("DELETE FROM users WHERE user_id = 'u1'");
          let settled = false;
          const write = h.storage.appendAuditEntry(row(), { generation }).finally(() => {
            settled = true;
          });
          await new Promise((r) => setTimeout(r, 200));
          expect(settled).toBe(false); // held on the user row
          await eraser.query("DELETE FROM audit_log WHERE user_id = 'u1'");
          await eraser.query('COMMIT');
          expect(await write).toBe(false);
          expect(await rows(h, 'u1')).toBe(0);
        } finally {
          await eraser.end();
        }
      });
    }

    if (driver.kind !== 'memory') {
      it('persists across a restart', async () => {
        const h = await driver.open();
        const written = row();
        await h.storage.appendAuditEntry(written);
        await h.storage.close();
        const again = await h.reopen();
        expect(await again.listAuditEntries('u1', {}, 10)).toEqual([written]);
      });

      it('upgrades a schema 6 database: the table and its indexes are created, the stamp is 7, nothing else changes', async () => {
        const h = await driver.open();
        const sql = h.sql as NonNullable<DriverHandle['sql']>;
        await seedUser(h.storage, 'u1');
        // As a database schema 6 left: no audit_log, stamped 6.
        await sql('DROP TABLE audit_log');
        await sql("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'");
        expect(await tableExists(h, 'audit_log')).toBe(false);

        const upgraded = await h.reopen();
        expect(await tableExists(h, 'audit_log')).toBe(true);
        expect((await indexes(h)).sort()).toEqual(['audit_log_ts', 'audit_log_user_ts']);
        expect((await sql("SELECT value FROM schema_meta WHERE key = 'schema_version'"))[0]?.['value']).toBe('7');
        expect(await upgraded.getUser('u1')).toBeDefined();
        expect(await upgraded.appendAuditEntry(row())).toBe(true);

        // A restart against the upgraded database changes nothing.
        const again = await h.reopen();
        expect(await again.listAuditEntries('u1', {}, 10)).toHaveLength(1);
        expect((await sql("SELECT value FROM schema_meta WHERE key = 'schema_version'"))[0]?.['value']).toBe('7');
      });
    }
  });
}

async function rows(h: DriverHandle, userId: string): Promise<number> {
  if (h.kind === 'memory') return (await h.userRows(userId))['audit'] ?? -1;
  const [r] = await (h.sql as NonNullable<DriverHandle['sql']>)('SELECT COUNT(*) AS n FROM audit_log WHERE user_id = $1', [userId]);
  return Number(r?.['n']);
}

async function tableExists(h: DriverHandle, table: string): Promise<boolean> {
  const sql = h.sql as NonNullable<DriverHandle['sql']>;
  if (h.kind === 'sqlite') {
    return (await sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1", [table])).length === 1;
  }
  return (await sql('SELECT to_regclass($1) IS NOT NULL AS present', [table]))[0]?.['present'] === true;
}

async function indexes(h: DriverHandle): Promise<string[]> {
  const sql = h.sql as NonNullable<DriverHandle['sql']>;
  if (h.kind === 'sqlite') {
    return (await sql("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log' AND sql IS NOT NULL")).map(
      (r) => String(r['name'])
    );
  }
  return (
    await sql("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_log' AND indexname <> 'audit_log_pkey'")
  ).map((r) => String(r['indexname']));
}
