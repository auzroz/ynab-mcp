/**
 * Byte-capped per-user caches (#58): Cache and DeltaCache share one byte budget
 * (default 8 MiB, serialized length on store), evict least recently used entries
 * across both, refuse an entry bigger than the whole budget, and the registry's
 * idle sweep prunes them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ByteBudget, DEFAULT_USER_CACHE_BYTES, serializedBytes } from '../../../src/services/byte-budget.js';
import { Cache } from '../../../src/services/cache.js';
import { DeltaCache, type Snapshot } from '../../../src/services/delta-cache.js';
import {
  CACHE_PRUNE_INTERVAL_MS,
  UserRegistry,
  createUserComponents,
} from '../../../src/services/user-registry.js';

/** A value whose serialized length is exactly `n` bytes (a JSON string: n - 2 characters plus quotes). */
function bytes(n: number): string {
  return 'x'.repeat(n - 2);
}

function snapshot(data: unknown, over: Partial<Snapshot> = {}): Snapshot {
  return { data, knowledge: 1, entities: 1, baseFetchedAt: Date.now(), ...over };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ByteBudget', () => {
  it('defaults to 8 MiB', () => {
    expect(DEFAULT_USER_CACHE_BYTES).toBe(8 * 1024 * 1024);
    expect(new ByteBudget().maxBytes).toBe(8 * 1024 * 1024);
  });

  it('measures the UTF-8 length of the serialized value', () => {
    expect(serializedBytes('abc')).toBe(5);
    expect(serializedBytes({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
    expect(serializedBytes(bytes(100))).toBe(100);
  });

  it('rejects a bad cap', () => {
    expect(() => new ByteBudget(0)).toThrow();
    expect(() => new ByteBudget(Number.NaN)).toThrow();
  });
});

describe('Cache with a byte budget', () => {
  it('counts what it stores and frees it on delete, expiry, clear and prefix delete', () => {
    const budget = new ByteBudget(10_000);
    const cache = new Cache(60_000, budget);
    cache.set('a:1', bytes(100));
    cache.set('a:2', bytes(200));
    cache.set('b', bytes(300));
    expect(budget.used).toBe(600);
    cache.set('b', bytes(50)); // replacing counts the new size only
    expect(budget.used).toBe(350);
    cache.deleteByPrefix('a:');
    expect(budget.used).toBe(50);
    cache.delete('b');
    expect(budget.used).toBe(0);
    cache.set('c', bytes(80));
    cache.clear();
    expect(budget.used).toBe(0);
  });

  it('evicts the least recently used entry past the cap, and a read counts as use', () => {
    const budget = new ByteBudget(300);
    const cache = new Cache(60_000, budget);
    cache.set('a', bytes(100));
    cache.set('b', bytes(100));
    cache.set('c', bytes(100));
    cache.get('a'); // a is now the most recent; b is the oldest
    cache.set('d', bytes(100));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(budget.used).toBe(300);
  });

  it('does not keep an entry bigger than the whole budget, and drops the old value under that key', () => {
    const budget = new ByteBudget(200);
    const cache = new Cache(60_000, budget);
    cache.set('a', bytes(100));
    cache.set('a', bytes(201));
    expect(cache.get('a')).toBeUndefined();
    expect(budget.used).toBe(0);
  });

  it('frees an expired entry when it is read or pruned', () => {
    vi.useFakeTimers();
    const budget = new ByteBudget(1000);
    const cache = new Cache(1000, budget);
    cache.set('a', bytes(100));
    cache.set('b', bytes(100));
    vi.advanceTimersByTime(1500);
    expect(cache.get('a')).toBeUndefined();
    expect(budget.used).toBe(100);
    expect(cache.prune()).toBe(1);
    expect(budget.used).toBe(0);
  });

  it('behaves as before without a budget', () => {
    const cache = new Cache(60_000);
    cache.set('a', bytes(10_000_000));
    expect(cache.get('a')).toBeDefined();
    expect(cache.byteUsage()).toBeUndefined();
  });
});

describe('DeltaCache with a byte budget', () => {
  it('counts snapshot bytes and frees them on delete, group drop and clear', () => {
    const budget = new ByteBudget(10_000);
    const deltas = new DeltaCache({ budget });
    deltas.offer('a', snapshot(bytes(100), { group: 'g' }));
    deltas.offer('b', snapshot(bytes(200)));
    expect(budget.used).toBe(300);
    deltas.dropGroup('g');
    expect(budget.used).toBe(200);
    deltas.offer('b', snapshot(bytes(50), { knowledge: 2 })); // replaced by a newer one
    expect(budget.used).toBe(50);
    deltas.clear();
    expect(budget.used).toBe(0);
  });

  it('does not keep a snapshot bigger than the whole budget', () => {
    const budget = new ByteBudget(100);
    const deltas = new DeltaCache({ budget });
    expect(deltas.offer('a', snapshot(bytes(101)))).toBe(false);
    expect(deltas.size()).toBe(0);
    expect(budget.used).toBe(0);
  });

  it('evicts the least recently used snapshot past the cap', () => {
    const budget = new ByteBudget(250);
    const deltas = new DeltaCache({ budget });
    deltas.offer('a', snapshot(bytes(100)));
    deltas.offer('b', snapshot(bytes(100)));
    deltas.get('a');
    expect(deltas.offer('c', snapshot(bytes(100)))).toBe(true);
    expect(deltas.get('b')).toBeUndefined();
    expect(deltas.get('a')).toBeDefined();
    expect(deltas.get('c')).toBeDefined();
  });

  it('prune() drops idle snapshots and frees their bytes', () => {
    let now = 1_000_000;
    const budget = new ByteBudget(10_000);
    const deltas = new DeltaCache({ budget, now: () => now, idleMs: 1000 });
    deltas.offer('a', snapshot(bytes(100), { baseFetchedAt: now }));
    now += 2000;
    expect(deltas.prune()).toBe(1);
    expect(budget.used).toBe(0);
  });
});

describe('one budget across Cache and DeltaCache', () => {
  it('evicts the least recently used entry whichever store holds it', () => {
    const budget = new ByteBudget(300);
    const cache = new Cache(60_000, budget);
    const deltas = new DeltaCache({ budget });
    cache.set('c1', bytes(100)); // oldest
    deltas.offer('s1', snapshot(bytes(100)));
    cache.set('c2', bytes(100));
    deltas.offer('s2', snapshot(bytes(100))); // 400 > 300: c1 goes
    expect(cache.get('c1')).toBeUndefined();
    expect(deltas.get('s1')).toBeDefined();
    expect(cache.get('c2')).toBeDefined();
    expect(deltas.get('s2')).toBeDefined();
    // The reads above touched s1, c2 and s2 in that order: s1 is now the oldest.
    cache.set('c3', bytes(100));
    expect(deltas.get('s1')).toBeUndefined();
    expect(deltas.get('s2')).toBeDefined();
    expect(budget.used).toBeLessThanOrEqual(300);
  });

  it('createUserComponents shares one 8 MiB budget between the two', () => {
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 60_000 });
    components.cache.set('k', bytes(1000));
    expect(components.cache.byteUsage()).toEqual({ bytes: 1000, maxBytes: DEFAULT_USER_CACHE_BYTES });
    components.deltaCache.offer('s', snapshot(bytes(500)));
    expect(components.cache.byteUsage()?.bytes).toBe(1500);
  });

  it('createUserComponents honours a smaller cap, and users never share a budget', () => {
    const a = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 60_000, cacheMaxBytes: 1000 });
    const b = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 60_000, cacheMaxBytes: 1000 });
    a.cache.set('x', bytes(900));
    b.cache.set('x', bytes(900));
    expect(a.cache.get('x')).toBeDefined();
    expect(b.cache.get('x')).toBeDefined();
    a.cache.set('y', bytes(900));
    expect(a.cache.get('x')).toBeUndefined();
    expect(b.cache.get('x')).toBeDefined();
  });
});

describe('UserRegistry idle sweep prunes the caches', () => {
  it('prunes expired entries and idle snapshots of every user, at most once per interval', () => {
    let now = 5_000_000;
    const registry = new UserRegistry({
      rateLimitPerHour: 180,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    const lease = registry.acquire('u1');
    const { cache, deltaCache } = lease.components;
    const cachePrune = vi.spyOn(cache, 'prune');
    const deltaPrune = vi.spyOn(deltaCache, 'prune');
    lease.release();

    now += CACHE_PRUNE_INTERVAL_MS;
    registry.acquire('u2').release();
    expect(cachePrune).toHaveBeenCalledTimes(1);
    expect(deltaPrune).toHaveBeenCalledTimes(1);

    now += CACHE_PRUNE_INTERVAL_MS - 1;
    registry.acquire('u2').release();
    expect(cachePrune).toHaveBeenCalledTimes(1);

    now += 1;
    registry.acquire('u2').release();
    expect(cachePrune).toHaveBeenCalledTimes(2);
  });

  it('actually frees an expired entry through the sweep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const registry = new UserRegistry({ rateLimitPerHour: 180, cacheTtlMs: 1000 });
    const lease = registry.acquire('u1');
    lease.components.cache.set('k', bytes(500));
    expect(lease.components.cache.byteUsage()?.bytes).toBe(500);
    lease.release();
    vi.advanceTimersByTime(CACHE_PRUNE_INTERVAL_MS + 1);
    registry.acquire('u2').release();
    expect(lease.components.cache.byteUsage()?.bytes).toBe(0);
  });
});
