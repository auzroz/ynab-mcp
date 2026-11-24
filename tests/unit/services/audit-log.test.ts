/**
 * The audit log service (#60a): what a row carries, the per-call tool and
 * request id, the generation guard, and that a store failure never throws.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditLog, LOCAL_AUDIT_USER } from '../../../src/services/audit-log.js';
import { MemoryAuditStore, type AuditStore } from '../../../src/storage/audit-rows.js';
import { MemoryStorage } from '../../../src/storage/memory.js';

const event = {
  operation: 'create',
  resourceType: 'transaction',
  tool: 'ynab_create_transaction',
  resourceId: 'txn-1',
  budgetId: 'budget-1',
  outcome: 'success',
} as const;

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
        budgetId: 'budget-1',
        outcome: 'success',
      },
    ]);
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
    await new AuditLog(storage, { userId: 'u1', generation: generation + 1 }).record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toHaveLength(1);
    await storage.deleteUserData('u1');
    await new AuditLog(storage, { userId: 'u1', generation }).record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([]);
  });

  it('never throws when the store fails, and logs the failure sanitized', async () => {
    const failing: AuditStore = {
      appendAuditEntry: vi.fn().mockRejectedValue(new Error('connection refused Bearer abc.def')),
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
    expect(errors).toHaveBeenCalledWith('[AUDIT] denied_scope: create on transaction via ynab_create_transaction');
  });
});
