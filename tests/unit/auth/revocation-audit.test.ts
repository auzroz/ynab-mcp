/**
 * #60b: the revocation recorder and the adapter-to-event link
 * (src/auth/revocation-audit.ts) on their own: what a row holds, the
 * generation guard, the bounded wait, and that the event records a grant only
 * when the request's adapter call deleted it, once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { KoaContextWithOIDC } from 'oidc-provider';
import {
  GrantRevocationTracker,
  createRevocationRecorder,
  onGrantRevoked,
  type RevocationEvent,
  type RevocationRecorder,
} from '../../../src/auth/revocation-audit.js';
import { MemoryStorage } from '../../../src/storage/memory.js';

const event: RevocationEvent = {
  userId: 'u1',
  clientId: 'client-a',
  familyId: 'grant-a',
  grantId: 'grant-a',
  outcome: 'revoked',
};

let storage: MemoryStorage;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  storage = new MemoryStorage();
  await storage.init();
  await storage.upsertUser({ userId: 'u1', grantedScope: 'read-write', encryptedRefreshToken: 'enc', updatedAt: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRevocationRecorder', () => {
  it('writes one row: the user, the client and its grant, the revoked grant, no tool, budget or request', async () => {
    await createRevocationRecorder(storage, { now: () => 42 }).record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([
      {
        ts: 42,
        userId: 'u1',
        clientId: 'client-a',
        familyId: 'grant-a',
        requestId: undefined,
        tool: undefined,
        operation: 'revoke',
        resourceType: 'grant',
        resourceId: 'grant-a',
        budgetId: undefined,
        outcome: 'revoked',
      },
    ]);
  });

  it('writes nothing without a user, or for a user that is gone (an erase)', async () => {
    const r = createRevocationRecorder(storage);
    await r.record({ ...event, userId: undefined });
    await r.record({ ...event, userId: 'ghost' });
    await storage.deleteUserData('u1');
    await r.record(event);
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([]);
    expect(await storage.listAuditEntries('ghost', {}, 10)).toEqual([]);
  });

  it('is guarded by the generation it read: an erase and reconnect in between drops the row', async () => {
    const generation = (await storage.getUser('u1'))?.createdAt ?? 0;
    const store = {
      getUser: vi.fn(async () => ({ ...(await storage.getUser('u1'))!, createdAt: generation })),
      appendAuditEntry: vi.fn(async (...args: Parameters<MemoryStorage['appendAuditEntry']>) => {
        // The erase lands between the read and the write.
        await storage.deleteUserData('u1');
        return storage.appendAuditEntry(...args);
      }),
    };
    await createRevocationRecorder(store).record(event);
    expect(store.appendAuditEntry.mock.calls[0]?.[1]).toEqual({ generation });
    expect(await storage.listAuditEntries('u1', {}, 10)).toEqual([]);
  });

  it('waits at most the bound for a stalled store, and never throws on a failed one (logged sanitized)', async () => {
    const stalled = { getUser: storage.getUser.bind(storage), appendAuditEntry: vi.fn(() => new Promise<boolean>(() => undefined)) };
    const started = Date.now();
    await createRevocationRecorder(stalled, { maxWaitMs: 50 }).record(event);
    expect(Date.now() - started).toBeLessThan(1000);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = { getUser: vi.fn().mockRejectedValue(new Error('connect failed Bearer abc.def')), appendAuditEntry: vi.fn() };
    await expect(createRevocationRecorder(failing).record(event)).resolves.toBeUndefined();
    const logged = errors.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('could not record a revocation');
    expect(logged).not.toContain('abc.def');
  });
});

describe('onGrantRevoked (the grant.revoked listener)', () => {
  const ctxFor = (route: string, clientId = 'client-a'): KoaContextWithOIDC =>
    ({ oidc: { route, client: { clientId } } }) as unknown as KoaContextWithOIDC;

  function recorder(): RevocationRecorder & { events: RevocationEvent[] } {
    const events: RevocationEvent[] = [];
    return { events, record: async (e) => void events.push(e) };
  }

  /** Mark `grantId` as deleted by `ctx`'s request, as the adapter does inside the library's request scope. */
  function markIn(tracker: GrantRevocationTracker, ctx: object, grantId: string): void {
    const marks = (tracker as unknown as { marks: WeakMap<object, Map<string, unknown>> }).marks;
    marks.set(ctx, new Map([[grantId, { accountId: 'u1', clientId: 'client-a' }]]));
  }

  it("records nothing for a grant this request's adapter did not delete (a cleanup, or a revoke that found it gone)", () => {
    const tracker = new GrantRevocationTracker();
    const r = recorder();
    onGrantRevoked(tracker, r)(ctxFor('revocation'), 'grant-a');
    expect(r.events).toEqual([]);
    // Outside a library request the adapter marks nothing.
    tracker.deleted('grant-a', { accountId: 'u1', clientId: 'client-a' });
    onGrantRevoked(tracker, r)(ctxFor('revocation'), 'grant-a');
    expect(r.events).toEqual([]);
  });

  it('records a marked grant once: revoked on /revoke, revoked_reuse on /token, nothing on another route', () => {
    const tracker = new GrantRevocationTracker();
    const r = recorder();
    const listener = onGrantRevoked(tracker, r);
    const revoke = ctxFor('revocation');
    markIn(tracker, revoke, 'grant-a');
    listener(revoke, 'grant-a');
    listener(revoke, 'grant-a');
    const token = ctxFor('token');
    markIn(tracker, token, 'grant-a');
    listener(token, 'grant-a');
    const other = ctxFor('end_session');
    markIn(tracker, other, 'grant-a');
    listener(other, 'grant-a');
    expect(r.events).toEqual([
      { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', grantId: 'grant-a', outcome: 'revoked' },
      { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', grantId: 'grant-a', outcome: 'revoked_reuse' },
    ]);
  });
});
