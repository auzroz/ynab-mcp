/**
 * UserRegistry: one rate limiter / cache / audit log per user, shared by that
 * user's sessions, never between users, and kept long enough after the last
 * session closes that reconnecting can't reset the rate limit.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import {
  UserRegistry,
  RATE_LIMIT_WINDOW_MS,
  headerUserKey,
} from '../../../src/services/user-registry.js';

const MINUTE = 60_000;

function setup(): { registry: UserRegistry; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  const registry = new UserRegistry({ rateLimitPerHour: 180, cacheTtlMs: 300000, now: () => clock.t });
  return { registry, clock };
}

describe('UserRegistry sharing and isolation', () => {
  it("shares one limiter, cache and audit log across one user's sessions", () => {
    const { registry } = setup();
    const a = registry.acquire('user-1');
    const b = registry.acquire('user-1');
    expect(b.components.rateLimiter).toBe(a.components.rateLimiter);
    expect(b.components.cache).toBe(a.components.cache);
    expect(b.components.deltaCache).toBe(a.components.deltaCache);
    expect(b.components.auditStore).toBe(a.components.auditStore);
    expect(b.components.clientUsage).toBe(a.components.clientUsage);
    expect(registry.size).toBe(1);
  });

  it('never shares a limiter, cache or audit log between two users', async () => {
    const { registry } = setup();
    const alice = registry.acquire('alice').components;
    const bob = registry.acquire('bob').components;
    expect(bob.rateLimiter).not.toBe(alice.rateLimiter);
    expect(bob.cache).not.toBe(alice.cache);
    expect(bob.deltaCache).not.toBe(alice.deltaCache);
    expect(bob.auditStore).not.toBe(alice.auditStore);
    expect(bob.clientUsage).not.toBe(alice.clientUsage);

    await alice.rateLimiter.acquire();
    alice.cache.set('k', 'alice-data');
    await alice.auditStore.appendAuditEntry({
      ts: 1,
      userId: 'local',
      clientId: undefined,
      familyId: undefined,
      requestId: undefined,
      tool: 'ynab_create_payee',
      operation: 'create',
      resourceType: 'payee',
      resourceId: undefined,
      budgetId: 'b',
      outcome: 'success',
    });
    alice.clientUsage.sent('client-a');
    expect(bob.rateLimiter.getStatus().used).toBe(0);
    expect(bob.cache.get('k')).toBeUndefined();
    expect(bob.auditStore.countFor('local')).toBe(0);
    expect(bob.clientUsage.status('client-a').sentLastHour).toBe(0);
  });

  it('keys header-mode users by a SHA-256 digest, never the raw token', () => {
    const key = headerUserKey('secret-ynab-token');
    expect(key).toBe(createHash('sha256').update('secret-ynab-token').digest('hex'));
    expect(key).not.toContain('secret');
    expect(headerUserKey('other-token')).not.toBe(key);
  });
});

describe('UserRegistry eviction', () => {
  it('does not reset the rate limit when a user reconnects', async () => {
    const { registry } = setup();
    const first = registry.acquire('user-1');
    for (let i = 0; i < 5; i++) await first.components.rateLimiter.acquire();
    first.release();
    const again = registry.acquire('user-1');
    expect(again.components.rateLimiter).toBe(first.components.rateLimiter);
    expect(again.components.rateLimiter.getStatus().available).toBe(175);
  });

  it('evicts an entry only after a full window with no live sessions', () => {
    const { registry, clock } = setup();
    const lease = registry.acquire('user-1');
    const original = lease.components;
    lease.release();

    clock.t += RATE_LIMIT_WINDOW_MS - 1;
    registry.acquire('other').release();
    expect(registry.size).toBe(2);

    clock.t += 1;
    registry.acquire('other').release();
    expect(registry.size).toBe(1);
    expect(registry.acquire('user-1').components).not.toBe(original);
  });

  it('never evicts an entry with a live session', () => {
    const { registry, clock } = setup();
    const live = registry.acquire('user-1');
    clock.t += 10 * RATE_LIMIT_WINDOW_MS;
    registry.acquire('other');
    expect(registry.acquire('user-1').components).toBe(live.components);
  });

  it('counts sessions: the entry stays while any session of the user is live', () => {
    const { registry, clock } = setup();
    const a = registry.acquire('user-1');
    const b = registry.acquire('user-1');
    a.release();
    a.release(); // idempotent: must not drop b's hold as well
    clock.t += 2 * RATE_LIMIT_WINDOW_MS;
    registry.acquire('other').release();
    expect(registry.size).toBe(2);

    b.release();
    clock.t += RATE_LIMIT_WINDOW_MS;
    registry.acquire('other').release();
    expect(registry.size).toBe(1); // user-1 evicted; only the re-created 'other' is left
  });

  it('keeps an idle entry whose rate limiter is still refilling', async () => {
    const { registry, clock } = setup();
    const lease = registry.acquire('user-1');
    lease.release();
    // Requests that were in flight when the session closed draw the bucket down.
    clock.t += RATE_LIMIT_WINDOW_MS - MINUTE;
    for (let i = 0; i < 180; i++) await lease.components.rateLimiter.acquire();

    clock.t += MINUTE;
    registry.acquire('other').release();
    expect(registry.acquire('user-1').components).toBe(lease.components);
  });

  it('builds each user\'s limiter with rateLimiterFor (#67c), and a shared one does not pin an idle entry', () => {
    const clock = { t: 0 };
    const built: string[] = [];
    // A shared limiter's budget lives in the database, so its status says `postgres`
    // and dropping the entry grants nothing, even while the bucket refills.
    const sharedStatus = { ...new RateLimiter(180).getStatus(), available: 3, store: 'postgres' as const };
    const registry = new UserRegistry({
      rateLimitPerHour: 180,
      cacheTtlMs: 300000,
      now: () => clock.t,
      rateLimiterFor: (userKey) => {
        built.push(userKey);
        const limiter = new RateLimiter(180, () => clock.t);
        limiter.getStatus = () => sharedStatus;
        return limiter;
      },
    });
    const lease = registry.acquire('user-1');
    lease.release();
    expect(built).toEqual(['user-1']);
    clock.t += RATE_LIMIT_WINDOW_MS;
    registry.acquire('other').release();
    expect(registry.acquire('user-1').components).not.toBe(lease.components);
    expect(built).toEqual(['user-1', 'other', 'user-1']);
  });

  it('past maxEntries, drops the least recently used idle entry, never a live one', () => {
    const clock = { t: 0 };
    const registry = new UserRegistry({ rateLimitPerHour: 180, cacheTtlMs: 300000, maxEntries: 2, now: () => clock.t });
    const live = registry.acquire('live');
    clock.t += 1;
    const idle = registry.acquire('idle');
    idle.release();
    clock.t += 1;

    registry.acquire('new');
    expect(registry.size).toBe(2);
    expect(registry.acquire('live').components).toBe(live.components);
    expect(registry.acquire('idle').components).not.toBe(idle.components);

    // All live: the bound yields rather than dropping a live session's state.
    expect(registry.size).toBe(3);
  });
});

describe('UserRegistry.drop (#53c, after ynab_disconnect)', () => {
  it("forgets the user's components at once, even under a live lease; the next acquire starts fresh", async () => {
    const { registry } = setup();
    const lease = registry.acquire('user-1');
    const other = registry.acquire('user-2');
    const old = lease.components;
    old.cache.set('k', 'cached budget data');
    await old.auditStore.appendAuditEntry({
      ts: 1,
      userId: 'user-1',
      clientId: undefined,
      familyId: undefined,
      requestId: undefined,
      tool: 'ynab_create_payee',
      operation: 'create',
      resourceType: 'payee',
      resourceId: undefined,
      budgetId: 'b',
      outcome: 'success',
    });

    registry.drop('user-1');
    expect(registry.size).toBe(1);
    expect(old.cache.get('k')).toBeUndefined();
    expect(old.auditStore.countFor('user-1')).toBe(0);

    // The dropped lease's release touches only its detached entry.
    lease.release();
    const next = registry.acquire('user-1');
    expect(next.components).not.toBe(old);
    expect(next.components.rateLimiter).not.toBe(old.rateLimiter);
    expect(registry.leases('user-1')).toBe(1);
    expect(registry.acquire('user-2').components).toBe(other.components);
  });

  it('is a no-op for a user with no entry', () => {
    const { registry } = setup();
    registry.acquire('user-2');
    registry.drop('nobody');
    expect(registry.size).toBe(1);
  });
});
