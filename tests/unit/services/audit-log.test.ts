/**
 * The audit log service (#60a): what a row carries, the per-call tool and
 * request id, the generation guard, and that a store failure never throws.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AUDIT_APPEND_MAX_WAIT_MS, AuditLog, LOCAL_AUDIT_USER } from '../../../src/services/audit-log.js';
import { MAX_AUDIT_ROWS_PER_CALL, MemoryAuditStore, type AuditStore } from '../../../src/storage/audit-rows.js';
import { MemoryStorage } from '../../../src/storage/memory.js';

const BUDGET = '77777777-7777-4777-8777-777777777777';

const event = {
  operation: 'create',
  resourceType: 'transaction',
  tool: 'ynab_create_transaction',
  resourceId: 'txn-1',
  budgetId: BUDGET,
  outcome: 'success',
} as const;

/** A store whose append never settles (a stalled database). */
function hangingStore(): AuditStore {
  return {
    appendAuditEntry: vi.fn(() => new Promise<boolean>(() => undefined)),
    appendAuditEntries: vi.fn(() => new Promise<boolean>(() => undefined)),
    listAuditEntries: vi.fn(),
    countAuditEntries: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('AuditLog', () => {
  it('records the context and the event, nothing else', async () => {
    const store = new MemoryAuditStore();
    const log = new AuditLog(
      store,
      { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', requestId: 'req-1' },
      () => 1_700_000_000_000
    );
    await log.record(event);
    expect(await store.listAuditEntries('u1', {}, 10)).toEqual([
      {
        ts: 1_700_000_000_000,
        userId: 'u1',
        clientId: 'client-a',
        familyId: 'grant-a',
        requestId: 'req-1',
        tool: 'ynab_create_transaction',
        operation: 'create',
        resourceType: 'transaction',
        resourceId: 'txn-1',
        budgetId: BUDGET,
        outcome: 'success',
      },
    ]);
  });

  it('stores a budget id only when it is identifier-shaped (a UUID, last-used or default)', async () => {
    const log = new AuditLog(new MemoryAuditStore(), { userId: 'u1' });
    for (const budgetId of [BUDGET, 'last-used', 'default', 'Sentinel budget\nsecond line', `${BUDGET}\n`, 'budget-1', '']) {
      await log.record({ ...event, budgetId });
    }
    expect((await log.list({}, 10)).reverse().map((e) => e.budgetId)).toEqual([
      BUDGET,
      'last-used',
      'default',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('waits for a stalled store at most the cap, then lets the append finish in the background', async () => {
    const store = hangingStore();
    const log = new AuditLog(store, { userId: 'u1' }, Date.now, 50);
    const started = Date.now();
    await log.record(event);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.appendAuditEntry).toHaveBeenCalledTimes(1);
    expect(AUDIT_APPEND_MAX_WAIT_MS).toBeLessThanOrEqual(1000);
  });

  it('waits at most half the time left before the call deadline', async () => {
    const log = new AuditLog(hangingStore(), { userId: 'u1', deadline: Date.now() + 200 });
    const started = Date.now();
    await log.record(event);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('defaults to the stdio user with no client', async () => {
    const log = new AuditLog();
    await log.record(event);
    const [entry] = await log.list({}, 10);
    expect(entry).toMatchObject({ userId: LOCAL_AUDIT_USER, clientId: undefined, familyId: undefined });
  });

  it('names the tools/call in progress and gives each stdio call its own request id', async () => {
    const log = new AuditLog();
    await log.runCall('ynab_move_money', async () => {
      expect(log.callRecorded()).toBe(false);
      await log.record({ ...event, operation: 'update', resourceType: 'category', tool: 'ynab_update_category' });
      expect(log.callRecorded()).toBe(true);
    });
    await log.runCall('ynab_create_payee', () => log.record({ ...event, tool: 'ynab_create_payee' }));
    const [second, first] = await log.list({}, 10);
    expect(first?.tool).toBe('ynab_move_money');
    expect(second?.tool).toBe('ynab_create_payee');
    expect(first?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.requestId).not.toBe(second?.requestId);
    // Outside a call: the event's own tool.
    await log.record(event);
    expect((await log.list({}, 1))[0]?.tool).toBe('ynab_create_transaction');
    expect(log.callRecorded()).toBe(false);
  });

  it("uses the HTTP request's id for every row of the request", async () => {
    const log = new AuditLog(new MemoryAuditStore(), { userId: 'u1', requestId: 'req-http' });
    await log.runCall('ynab_create_payee', () => log.record(event));
    await log.record(event);
    expect((await log.list({}, 10)).map((e) => e.requestId)).toEqual(['req-http', 'req-http']);
  });

  it('strips control characters from ids and drops empty ones', async () => {
    const log = new AuditLog(new MemoryAuditStore(), { userId: 'u1', clientId: 'client\u0000-a\n', familyId: '' });
    await log.record({ ...event, resourceId: 'txn‮-1' });
    const [entry] = await log.list({}, 10);
    expect(entry?.clientId).toBe('client-a');
    expect(entry?.familyId).toBeUndefined();
    expect(entry?.resourceId).toBe('txn-1');
  });

  it('with a generation, writes only while that user row exists', async () => {
    const storage = new MemoryStorage();
    await storage.init();
    await storage.upsertUser({ userId: 'u1', grantedScope: 'read-write', encryptedRefreshToken: 'enc', updatedAt: 1 });
    const generation = (await storage.getUser('u1'))?.createdAt ?? 0;
    await new AuditLog(storage, { userId: 'u1', generation }).record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toHaveLength(1);
    // Another generation (erased and connected again since): refused.
    await new AuditLog(storage, { userId: 'u1', generation: generation + 1 }).record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toHaveLength(1);
    await storage.deleteUserData('u1');
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([]);
    await new AuditLog(storage, { userId: 'u1', generation }).record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([]);
  });

  it('never throws when the store fails, and logs the failure sanitized', async () => {
    const failing: AuditStore = {
      appendAuditEntry: vi.fn().mockRejectedValue(new Error('connection refused Bearer abc.def')),
      appendAuditEntries: vi.fn().mockRejectedValue(new Error('connection refused Bearer abc.def')),
      listAuditEntries: vi.fn(),
      countAuditEntries: vi.fn(),
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new AuditLog(failing).record(event)).resolves.toBeUndefined();
    const logged = errors.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('could not record an entry');
    expect(logged).not.toContain('abc.def');
  });

  it('logs one stderr line per row, with ids and vocabulary only', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new AuditLog().record({ ...event, outcome: 'denied_scope', resourceId: undefined });
    expect(errors.mock.calls).toEqual([['[AUDIT] denied_scope: create on transaction via ynab_create_transaction']]);
  });
});

describe('AuditLog.recordMany (#60b: per-item rows of a bulk call)', () => {
  const bulk = { operation: 'create', resourceType: 'transaction', tool: 'ynab_create_transactions', budgetId: BUDGET, outcome: 'success' } as const;
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `txn-${i}`);

  it('writes one row per id, all with the call request id, as one batched append', async () => {
    const store = new MemoryAuditStore();
    const one = vi.spyOn(store, 'appendAuditEntry');
    const many = vi.spyOn(store, 'appendAuditEntries');
    const log = new AuditLog(store, { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', requestId: 'req-bulk' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await log.runCall('ynab_create_transactions', () => log.recordMany(bulk, ids(3)));
    expect(many).toHaveBeenCalledTimes(1);
    expect(one).not.toHaveBeenCalled();
    const rows = await log.list({}, 10);
    expect(rows.map((r) => r.resourceId).sort()).toEqual(ids(3));
    for (const r of rows) {
      expect(r).toMatchObject({ requestId: 'req-bulk', clientId: 'client-a', familyId: 'grant-a', tool: 'ynab_create_transactions', budgetId: BUDGET });
    }
    // One log line for the call, not one per row.
    expect(errors.mock.calls).toEqual([['[AUDIT] success: create on transaction (3 items) via ynab_create_transactions']]);
    expect(log.callRecorded()).toBe(false);
  });

  it('marks the call recorded, so the tools/call guard adds no second row', async () => {
    const log = new AuditLog();
    await log.runCall('ynab_update_transactions', async () => {
      await log.recordMany({ ...bulk, operation: 'update' }, ids(2));
      expect(log.callRecorded()).toBe(true);
    });
  });

  it('with no id (YNAB saved nothing, every item a duplicate) writes one row without a resource id', async () => {
    const log = new AuditLog(new MemoryAuditStore(), { userId: 'u1' });
    await log.recordMany(bulk, []);
    const rows = await log.list({}, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceId).toBeUndefined();
  });

  it('one id is one row, through the single-row append', async () => {
    const store = new MemoryAuditStore();
    const many = vi.spyOn(store, 'appendAuditEntries');
    await new AuditLog(store, { userId: 'u1' }).recordMany(bulk, ['txn-only']);
    expect(many).not.toHaveBeenCalled();
    expect((await store.listAuditEntries('u1', {}, 10)).map((r) => r.resourceId)).toEqual(['txn-only']);
  });

  it(`drops duplicate and empty ids, and records at most ${MAX_AUDIT_ROWS_PER_CALL} rows`, async () => {
    const log = new AuditLog(new MemoryAuditStore(), { userId: 'u1' });
    await log.recordMany(bulk, ['a', 'a', '', 'b']);
    expect((await log.list({}, 10)).map((r) => r.resourceId).sort()).toEqual(['a', 'b']);
    const capped = new AuditLog(new MemoryAuditStore(), { userId: 'u2' });
    await capped.recordMany(bulk, ids(MAX_AUDIT_ROWS_PER_CALL + 20));
    expect(await capped.list({}, 1000)).toHaveLength(MAX_AUDIT_ROWS_PER_CALL);
  });

  it('waits for a stalled store once, at most the cap, whatever the number of rows', async () => {
    const store = hangingStore();
    const log = new AuditLog(store, { userId: 'u1' }, Date.now, 50);
    const started = Date.now();
    await log.recordMany(bulk, ids(100));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.appendAuditEntries).toHaveBeenCalledTimes(1);
    expect(store.appendAuditEntry).not.toHaveBeenCalled();
  });

  it('waits at most half the time left before the call deadline', async () => {
    const log = new AuditLog(hangingStore(), { userId: 'u1', deadline: Date.now() + 200 });
    const started = Date.now();
    await log.recordMany(bulk, ids(100));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('never throws when the store fails, synchronously or not', async () => {
    const throwing = {
      ...hangingStore(),
      appendAuditEntries: vi.fn(() => {
        throw new Error('boom Bearer abc.def');
      }),
    } as unknown as AuditStore;
    await expect(new AuditLog(throwing).recordMany(bulk, ids(2))).resolves.toBeUndefined();
  });

  it('writes a batch only while the user row of its generation exists (an erase mid-call leaves none)', async () => {
    const storage = new MemoryStorage();
    await storage.init();
    await storage.upsertUser({ userId: 'u1', grantedScope: 'read-write', encryptedRefreshToken: 'enc', updatedAt: 1 });
    const generation = (await storage.getUser('u1'))?.createdAt ?? 0;
    const log = new AuditLog(storage, { userId: 'u1', generation });
    await log.recordMany(bulk, ids(3));
    expect(await storage.listAuditEntries('u1', {}, 10)).toHaveLength(3);
    await storage.deleteUserData('u1');
    await log.recordMany(bulk, ids(3));
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([]);
  });
});

describe('AuditLog.recordRevocation (#60b)', () => {
  it('records the caller and what was revoked, with no budget', async () => {
    const log = new AuditLog(
      new MemoryAuditStore(),
      { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', requestId: 'req-1' },
      () => 5
    );
    await log.runCall('ynab_revoke_connection', () =>
      log.recordRevocation({ resourceType: 'grant', resourceId: 'grant-b', outcome: 'revoked' })
    );
    expect(await log.list({}, 10)).toEqual([
      {
        ts: 5,
        userId: 'u1',
        clientId: 'client-a',
        familyId: 'grant-a',
        requestId: 'req-1',
        tool: 'ynab_revoke_connection',
        operation: 'revoke',
        resourceType: 'grant',
        resourceId: 'grant-b',
        budgetId: undefined,
        outcome: 'revoked',
      },
    ]);
  });
});

