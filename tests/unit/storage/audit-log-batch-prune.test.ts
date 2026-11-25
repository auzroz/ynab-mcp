/**
 * #60b on every driver: a bulk call's rows as one batched insert (all or
 * none, under the account-generation guard), and the retention prune
 * (`AUDIT_RETENTION_DAYS`) that the sweep runs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { MemoryAuditStore, auditInsertMany, type AuditRecord } from '../../../src/storage/audit-rows.js';
import type { Storage } from '../../../src/storage/types.js';

afterEach(async () => {
  await cleanupDrivers();
});

const DAY = 86_400_000;

function row(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: Date.now(),
    userId: 'u1',
    clientId: 'client-a',
    familyId: 'grant-a',
    requestId: 'req-bulk',
    tool: 'ynab_create_transactions',
    operation: 'create',
    resourceType: 'transaction',
    resourceId: 'txn-1',
    budgetId: 'budget-1',
    outcome: 'success',
    ...overrides,
  };
}

const batch = (n: number, overrides: Partial<AuditRecord> = {}): AuditRecord[] =>
  Array.from({ length: n }, (_, i) => row({ resourceId: `txn-${i}`, ...overrides }));

async function seedUser(s: Storage, userId: string): Promise<number> {
  await s.upsertUser({ userId, grantedScope: 'read-write', encryptedRefreshToken: `enc-${userId}`, updatedAt: Date.now() });
  return (await s.getUser(userId))?.createdAt ?? 0;
}

async function count(h: DriverHandle, userId: string): Promise<number> {
  if (h.kind === 'memory') return (await h.userRows(userId))['audit'] ?? -1;
  const [r] = await (h.sql as NonNullable<DriverHandle['sql']>)('SELECT COUNT(*) AS n FROM audit_log WHERE user_id = $1', [userId]);
  return Number(r?.['n']);
}

describe('auditInsertMany', () => {
  it('has a fixed number of parameters whatever the batch size (no per-row placeholders)', () => {
    for (const dialect of ['sqlite', 'postgres'] as const) {
      const small = auditInsertMany(dialect, batch(1), { generation: 1 });
      const large = auditInsertMany(dialect, batch(100), { generation: 1 });
      expect(large.params).toHaveLength(small.params.length);
      expect(large.sql).toBe(small.sql);
    }
  });

  it("refuses an empty batch and one with several users' rows", async () => {
    expect(() => auditInsertMany('sqlite', [])).toThrow(/at least one row/);
    expect(() => auditInsertMany('postgres', [row(), row({ userId: 'u2' })])).toThrow(/one user/);
    await expect(new MemoryAuditStore().appendAuditEntries([row(), row({ userId: 'u2' })])).rejects.toThrow(/one user/);
  });
});

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`audit log batches and prune (#60b): ${driver.name}`, () => {
    it("writes a bulk call's rows, each with its id and the call's request id", async () => {
      const h = await driver.open();
      const s = h.storage;
      const generation = await seedUser(s, 'u1');
      expect(await s.appendAuditEntries(batch(100), { generation })).toBe(true);
      const listed = await s.listAuditEntries('u1', {}, 200);
      expect(listed).toHaveLength(100);
      expect(new Set(listed.map((e) => e.requestId))).toEqual(new Set(['req-bulk']));
      expect(new Set(listed.map((e) => e.resourceId))).toEqual(new Set(batch(100).map((e) => e.resourceId)));
      // Every field as written, nulls included.
      await s.appendAuditEntries([row({ resourceId: 'solo', clientId: undefined, budgetId: undefined, requestId: 'r2' })]);
      const [solo] = await s.listAuditEntries('u1', { outcomes: ['success'] }, 1);
      expect(solo).toEqual(row({ resourceId: 'solo', clientId: undefined, budgetId: undefined, requestId: 'r2', ts: solo!.ts }));
    });

    it('a guarded batch is written whole while the user row of that generation exists, else not at all', async () => {
      const h = await driver.open();
      const s = h.storage;
      const generation = await seedUser(s, 'u1');
      expect(await s.appendAuditEntries(batch(5), { generation: generation + 1 })).toBe(false);
      expect(await s.appendAuditEntries(batch(5, { userId: 'ghost' }), { generation: 0 })).toBe(false);
      expect(await count(h, 'u1')).toBe(0);
      expect(await count(h, 'ghost')).toBe(0);
      expect(await s.appendAuditEntries(batch(5), { generation })).toBe(true);
      expect(await count(h, 'u1')).toBe(5);
      // The erase takes them (D-7b), and a batch settling after it writes nothing.
      await s.deleteUserData('u1');
      expect(await s.appendAuditEntries(batch(5), { generation })).toBe(false);
      expect(await count(h, 'u1')).toBe(0);
    });

    if (driver.kind === 'postgres') {
      it('a guarded batch racing an erase on another replica waits for it and writes nothing', async () => {
        const h = await driver.open();
        const generation = await seedUser(h.storage, 'u1');
        const pg = (await import('pg')).default;
        const eraser = new pg.Client({ connectionString: h.connectionString });
        await eraser.connect();
        try {
          await eraser.query('BEGIN');
          await eraser.query("DELETE FROM users WHERE user_id = 'u1'");
          let settled = false;
          const write = h.storage.appendAuditEntries(batch(20), { generation }).finally(() => {
            settled = true;
          });
          await new Promise((r) => setTimeout(r, 200));
          expect(settled).toBe(false); // held on the user row (FOR KEY SHARE OF u)
          await eraser.query("DELETE FROM audit_log WHERE user_id = 'u1'");
          await eraser.query('COMMIT');
          expect(await write).toBe(false);
          expect(await count(h, 'u1')).toBe(0);
        } finally {
          await eraser.end();
        }
      });
    }

    it('the prune deletes rows older than the retention window only, for every user, in batches', async () => {
      const h = await driver.open({ retention: { auditRetentionMs: 10 * DAY } });
      const s = h.storage;
      const now = Date.now();
      for (let i = 0; i < 5; i++) await s.appendAuditEntry(row({ ts: now - 11 * DAY - i, resourceId: `old-${i}` }));
      await s.appendAuditEntry(row({ userId: 'u2', ts: now - 30 * DAY, resourceId: 'old-u2' }));
      // At the boundary: exactly the window old is kept (`ts < now - window` goes).
      await s.appendAuditEntry(row({ ts: now - 10 * DAY, resourceId: 'edge' }));
      await s.appendAuditEntry(row({ ts: now - DAY, resourceId: 'recent' }));
      await s.appendAuditEntry(row({ userId: 'u2', ts: now, resourceId: 'new-u2' }));

      expect(await s.pruneAuditLog({ now, batchSize: 2 })).toBe(6);
      expect((await s.listAuditEntries('u1', {}, 10)).map((e) => e.resourceId)).toEqual(['recent', 'edge']);
      expect((await s.listAuditEntries('u2', {}, 10)).map((e) => e.resourceId)).toEqual(['new-u2']);
      // Nothing left to prune.
      expect(await s.pruneAuditLog({ now, batchSize: 2 })).toBe(0);
    });

    it('the prune refuses a batch size that is not a positive integer, before any statement', async () => {
      const h = await driver.open();
      const s = h.storage;
      await s.appendAuditEntry(row({ ts: 0, resourceId: 'old' }));
      for (const batchSize of [0, -1, 1.5, Number.NaN]) {
        await expect(s.pruneAuditLog({ batchSize })).rejects.toThrow(/positive integer/);
      }
      expect((await s.listAuditEntries('u1', {}, 10)).map((e) => e.resourceId)).toEqual(['old']);
    });

    it('the default window is 90 days', async () => {
      const h = await driver.open();
      const s = h.storage;
      const now = Date.now();
      await s.appendAuditEntry(row({ ts: now - 91 * DAY, resourceId: 'old' }));
      await s.appendAuditEntry(row({ ts: now - 89 * DAY, resourceId: 'kept' }));
      expect(await s.pruneAuditLog({ now })).toBe(1);
      expect((await s.listAuditEntries('u1', {}, 10)).map((e) => e.resourceId)).toEqual(['kept']);
    });

    if (driver.kind === 'sqlite') {
      it("the prune's batch select uses the (ts) index", async () => {
        const h = await driver.open();
        const plan = await (h.sql as NonNullable<DriverHandle['sql']>)(
          'EXPLAIN QUERY PLAN SELECT id FROM audit_log WHERE ts < $1 LIMIT $2',
          [0, 10]
        );
        expect(plan.map((r) => String(r['detail'])).join(' ')).toContain('audit_log_ts');
      });
    }

    if (driver.kind === 'postgres') {
      it("the prune's batch select uses the (ts) index", async () => {
        const h = await driver.open();
        const sql = h.sql as NonNullable<DriverHandle['sql']>;
        for (let i = 0; i < 50; i++) await h.storage.appendAuditEntry(row({ ts: i }));
        await sql('ANALYZE audit_log');
        // A tiny table is cheapest to scan; ask for the plan the index allows.
        const pg = (await import('pg')).default;
        const c = new pg.Client({ connectionString: h.connectionString });
        await c.connect();
        try {
          await c.query('SET enable_seqscan = off');
          const plan = await c.query('EXPLAIN SELECT id FROM audit_log WHERE ts < $1 LIMIT $2 FOR UPDATE SKIP LOCKED', [10, 5]);
          expect(plan.rows.map((r: Record<string, unknown>) => String(r['QUERY PLAN'])).join(' ')).toContain('audit_log_ts');
        } finally {
          await c.end();
        }
      });
    }
  });
}
