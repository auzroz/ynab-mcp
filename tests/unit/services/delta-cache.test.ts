/**
 * DeltaCache: knowledge-ordered stores and the memory bounds (snapshot count,
 * total entities, idle time, maximum age).
 */

import { describe, it, expect } from 'vitest';
import {
  DeltaCache,
  DELTA_DENORMALIZED_MAX_AGE_MS,
  DELTA_IDLE_MS,
  DELTA_MAX_AGE_MS,
  DELTA_MAX_ENTITIES,
  DELTA_MAX_SNAPSHOTS,
  type Snapshot,
} from '../../../src/services/delta-cache.js';

function setup(opts: { maxSnapshots?: number; maxEntities?: number; idleMs?: number; maxAgeMs?: number } = {}) {
  const clock = { t: 1_000_000 };
  const cache = new DeltaCache({ ...opts, now: () => clock.t });
  const snap = (knowledge: number, entities = 1, data: unknown = knowledge): Snapshot => ({
    data,
    knowledge,
    entities,
    baseFetchedAt: clock.t,
  });
  return { cache, clock, snap };
}

describe('DeltaCache offers', () => {
  it('stores and returns a snapshot', () => {
    const { cache, snap } = setup();
    const s = snap(10);
    expect(cache.offer('k', s)).toBe(true);
    expect(cache.get('k')).toBe(s);
    expect(cache.size()).toBe(1);
  });

  it('a refresh replaces its own base even at equal knowledge', () => {
    const { cache, snap } = setup();
    const base = snap(10);
    cache.offer('k', base);
    const next = snap(10, 1, 'refreshed');
    expect(cache.offer('k', next, base)).toBe(true);
    expect(cache.get('k')).toBe(next);
  });

  it('never moves a key back to older (or equal) knowledge from another lineage', () => {
    const { cache, snap } = setup();
    const base = snap(10);
    cache.offer('k', base);
    const newer = snap(30);
    cache.offer('k', newer, base);
    // A concurrent refresh of the same base that finished later with less knowledge.
    expect(cache.offer('k', snap(20), base)).toBe(false);
    expect(cache.offer('k', snap(30))).toBe(false);
    expect(cache.get('k')).toBe(newer);
    expect(cache.offer('k', snap(31))).toBe(true);
  });

  it('delete with an expected snapshot leaves a newer one alone', () => {
    const { cache, snap } = setup();
    const old = snap(1);
    cache.offer('k', old);
    const newer = snap(2);
    cache.offer('k', newer, old);
    expect(cache.delete('k', old)).toBe(false);
    expect(cache.get('k')).toBe(newer);
    expect(cache.delete('k')).toBe(true);
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('DeltaCache memory bounds', () => {
  it('documents its defaults', () => {
    expect(DELTA_MAX_SNAPSHOTS).toBe(32);
    expect(DELTA_MAX_ENTITIES).toBe(20_000);
    expect(DELTA_IDLE_MS).toBe(30 * 60 * 1000);
    expect(DELTA_MAX_AGE_MS).toBe(60 * 60 * 1000);
  });

  it('evicts the least recently used snapshot past the snapshot cap', () => {
    const { cache, snap } = setup({ maxSnapshots: 2 });
    cache.offer('a', snap(1));
    cache.offer('b', snap(1));
    cache.get('a'); // a is now more recent than b
    cache.offer('c', snap(1));
    expect(cache.size()).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('evicts least recently used snapshots past the entity cap and tracks the total', () => {
    const { cache, snap } = setup({ maxEntities: 10 });
    cache.offer('a', snap(1, 4));
    cache.offer('b', snap(1, 4));
    expect(cache.entityCount()).toBe(8);
    cache.offer('c', snap(1, 4));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.entityCount()).toBe(8);
    // Replacing a key's snapshot replaces its count.
    const b = cache.get('b') as Snapshot;
    cache.offer('b', snap(2, 1), b);
    expect(cache.entityCount()).toBe(5);
  });

  it('does not keep a single result larger than the entity cap', () => {
    const { cache, snap } = setup({ maxEntities: 10 });
    cache.offer('a', snap(1, 3));
    expect(cache.offer('big', snap(1, 11))).toBe(false);
    expect(cache.get('big')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.entityCount()).toBe(3);
  });

  it('drops snapshots unused for the idle time', () => {
    const { cache, clock, snap } = setup({ idleMs: 1000, maxAgeMs: 100_000 });
    cache.offer('a', snap(1));
    cache.offer('b', snap(1));
    clock.t += 600;
    cache.get('a');
    clock.t += 600;
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.size()).toBe(1);
  });

  it('drops a snapshot whose lineage is older than the maximum age, even while in use', () => {
    const { cache, clock, snap } = setup({ idleMs: 100_000, maxAgeMs: 1000 });
    let current = snap(1);
    cache.offer('a', current);
    for (let i = 2; i <= 4; i++) {
      clock.t += 300;
      const next: Snapshot = { ...snap(i), baseFetchedAt: current.baseFetchedAt };
      cache.offer('a', next, current);
      current = next;
    }
    expect(cache.get('a')).toBe(current);
    clock.t += 200;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.entityCount()).toBe(0);
  });

  it('rejects invalid bounds', () => {
    expect(() => new DeltaCache({ maxSnapshots: 0 })).toThrow('Invalid delta cache');
    expect(() => new DeltaCache({ idleMs: Number.NaN })).toThrow('Invalid delta cache');
  });
});

describe('DeltaCache groups and names', () => {
  it('dropGroup drops only that group and refuses offers that began before the drop', () => {
    const { cache, snap } = setup();
    const g = (k: number, group: string): Snapshot => ({ ...snap(k), group });
    cache.offer('a', g(10, 'g1'));
    cache.offer('b', g(10, 'g2'));
    cache.offer('c', snap(10));
    const before = cache.generation('g1');
    cache.dropGroup('g1');
    expect([cache.get('a'), cache.get('b') !== undefined, cache.get('c') !== undefined]).toEqual([undefined, true, true]);
    expect(cache.generation('g1')).not.toBe(before);
    expect(cache.offer('a', g(11, 'g1'), undefined, before)).toBe(false);
    expect(cache.offer('a', g(11, 'g1'), undefined, cache.generation('g1'))).toBe(true);
    // Other groups' and ungrouped generations are untouched.
    expect(cache.offer('b', g(11, 'g2'), cache.get('b'), cache.generation('g2'))).toBe(true);
    expect(cache.generation(undefined)).toBe(0);
  });

  it('dropAllGroups drops every grouped snapshot and bumps every group', () => {
    const { cache, snap } = setup();
    cache.offer('a', { ...snap(10), group: 'g1' });
    cache.offer('c', snap(10));
    const before = cache.generation('g2');
    cache.dropAllGroups();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.generation('g2')).not.toBe(before);
  });

  it('denormalized snapshots are dropped after DELTA_DENORMALIZED_MAX_AGE_MS, others after DELTA_MAX_AGE_MS', () => {
    const { cache, clock, snap } = setup({ idleMs: DELTA_MAX_AGE_MS * 2 });
    cache.offer('names', { ...snap(10), denormalized: true });
    cache.offer('plain', snap(10));
    clock.t += DELTA_DENORMALIZED_MAX_AGE_MS;
    expect(cache.get('names')).toBeUndefined();
    expect(cache.get('plain')).toBeDefined();
    clock.t += DELTA_MAX_AGE_MS - DELTA_DENORMALIZED_MAX_AGE_MS;
    expect(cache.get('plain')).toBeUndefined();
    expect(DELTA_DENORMALIZED_MAX_AGE_MS).toBeLessThan(DELTA_MAX_AGE_MS);
  });

  it('noteNames reports renames and removals, not additions or the first sighting', () => {
    const { cache } = setup();
    const m = (entries: Array<[string, number]>) => new Map(entries);
    expect(cache.noteNames('k', m([['a', 1], ['b', 2]]))).toBe(false);
    expect(cache.noteNames('k', m([['a', 1], ['b', 2], ['c', 3]]))).toBe(false); // added
    expect(cache.noteNames('k', m([['a', 1], ['b', 9], ['c', 3]]))).toBe(true); // renamed
    expect(cache.noteNames('k', m([['a', 1], ['c', 3]]))).toBe(true); // removed
    expect(cache.noteNames('other', m([['a', 5]]))).toBe(false); // keys are independent
  });
});
