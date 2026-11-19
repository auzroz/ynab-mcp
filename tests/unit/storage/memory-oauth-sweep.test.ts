/**
 * MemoryStorage's oauth_rows sweep (the default driver) must stay linear in
 * the table: each rule builds its lookup set once instead of scanning the
 * table per candidate row. Behaviour is pinned by the shared conformance suite;
 * this pins the cost.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../../../src/storage/memory.js';
import type { OAuthRowRecord } from '../../../src/storage/types.js';

describe('MemoryStorage oauth_rows sweep', () => {
  it('sweeps a 20k-row table across the lookup rules in linear time', async () => {
    const store = new MemoryStorage();
    const rows = (store as unknown as { oauthRows: Map<string, OAuthRowRecord> }).oauthRows;
    const base = { payload: '{}', accountId: undefined, uid: undefined, expiresAt: undefined, consumedAt: undefined, authorizedAt: undefined, createdAt: 0 } as const;
    const now = Date.now();
    const per = 5000;
    for (let i = 0; i < per; i++) {
      // A token whose grant row exists but whose account is gone: orphaned, then its grant is unused.
      rows.set(`t${i}`, { ...base, key: `t${i}`, model: 'AccessToken', grantId: `g${i}`, clientId: undefined, expiresAt: now + 60_000 });
      rows.set(`g${i}`, { ...base, key: `g${i}`, model: 'Grant', grantId: `g${i}`, clientId: undefined, expiresAt: now - 1000 });
      // A client nothing refers to, never authorized.
      rows.set(`c${i}`, { ...base, key: `c${i}`, model: 'Client', grantId: undefined, clientId: `c${i}` });
      // A consumed code long past retention whose grant has no live token.
      rows.set(`k${i}`, { ...base, key: `k${i}`, model: 'AuthorizationCode', grantId: `gone${i}`, clientId: undefined, consumedAt: 1 });
    }
    expect(rows.size).toBe(4 * per);

    const started = performance.now();
    const result = await store.sweepExpired({ now });
    const elapsed = performance.now() - started;

    expect(result.deleted.oauthOrphans).toBe(per);
    expect(result.deleted.oauthGrants).toBe(per);
    expect(result.deleted.oauthAbandonedClients).toBe(per);
    expect(result.deleted.oauthConsumed).toBe(per);
    expect(rows.size).toBe(0);
    // Linear takes tens of milliseconds; the per-row scan this replaced takes many seconds.
    expect(elapsed).toBeLessThan(3000);
  });
});
