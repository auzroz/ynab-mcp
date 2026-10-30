/**
 * Delta merge semantics per resource: upsert by key keeping positions, removal of
 * deleted entities, nested categories (including moves between groups), and
 * transactions replacing their subtransactions wholesale.
 */

import { describe, it, expect } from 'vitest';
import {
  DeltaMergeError,
  countCategoryEntities,
  countTransactionEntities,
  mergeBy,
  mergeById,
  mergeCategoryGroups,
  mergeTransactions,
  orderLike,
  withoutDeletedSubtransactions,
} from '../../../src/services/delta-merge.js';

const acct = (id: string, balance: number, deleted = false) => ({ id, name: id, balance, deleted });

describe('mergeById (accounts, payees, scheduled transactions)', () => {
  it('replaces changed entities in place, appends new ones, drops deleted ones', () => {
    const base = [acct('a', 1), acct('b', 2), acct('c', 3)];
    const merged = mergeById(base, [acct('b', 20), acct('d', 4), acct('c', 3, true)]);
    expect(merged).toEqual([acct('a', 1), acct('b', 20), acct('d', 4)]);
  });

  it('does not mutate its inputs', () => {
    const base = [acct('a', 1)];
    const delta = [acct('a', 2)];
    mergeById(base, delta);
    expect(base).toEqual([acct('a', 1)]);
    expect(delta).toEqual([acct('a', 2)]);
  });

  it('ignores a deletion of an entity it never had', () => {
    expect(mergeById([acct('a', 1)], [acct('zz', 0, true)])).toEqual([acct('a', 1)]);
  });

  it('an empty delta returns an equal copy', () => {
    const base = [acct('a', 1)];
    const merged = mergeById(base, []);
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });

  it('a keep predicate removes changed entities that left the query', () => {
    const merged = mergeById([acct('a', 1), acct('b', 2)], [acct('a', -5)], { keep: (e) => e.balance > 0 });
    expect(merged).toEqual([acct('b', 2)]);
  });

  it('throws DeltaMergeError for an entity without an id', () => {
    expect(() => mergeById([acct('a', 1)], [{ name: 'x' } as never])).toThrow(DeltaMergeError);
    expect(() => mergeById([acct('a', 1)], [null as never])).toThrow(DeltaMergeError);
  });

  it('throws DeltaMergeError when the delta list is missing', () => {
    expect(() => mergeById([acct('a', 1)], undefined as never)).toThrow(DeltaMergeError);
  });
});

describe('mergeBy months (keyed by month) and orderLike', () => {
  const m = (month: string, income: number, deleted = false) => ({ month, income, deleted });

  it('upserts by month and keeps the full fetch order (descending)', () => {
    const base = [m('2026-03-01', 3), m('2026-02-01', 2), m('2026-01-01', 1)];
    const merged = orderLike(
      base,
      mergeBy(base, [m('2026-04-01', 4), m('2026-02-01', 22)], (x) => x.month),
      (x) => x.month
    );
    expect(merged.map((x) => x.month)).toEqual(['2026-04-01', '2026-03-01', '2026-02-01', '2026-01-01']);
    expect(merged[2]?.income).toBe(22);
  });

  it('keeps ascending order too, and leaves an unsorted base as merged', () => {
    const asc = [m('2026-01-01', 1), m('2026-02-01', 2)];
    expect(orderLike(asc, [...asc, m('2025-12-01', 0)], (x) => x.month).map((x) => x.month)).toEqual([
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
    const unsorted = [m('2026-02-01', 2), m('2026-01-01', 1), m('2026-03-01', 3)];
    const merged = [...unsorted, m('2025-01-01', 0)];
    expect(orderLike(unsorted, merged.slice(), (x) => x.month)).toEqual(merged);
  });
});

describe('mergeCategoryGroups', () => {
  const cat = (id: string, group: string, budgeted = 0, deleted = false) => ({
    id,
    category_group_id: group,
    name: id,
    budgeted,
    deleted,
  });
  const group = (id: string, categories: ReturnType<typeof cat>[], extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    hidden: false,
    deleted: false,
    categories,
    ...extra,
  });
  const base = [group('g1', [cat('c1', 'g1', 1), cat('c2', 'g1', 2)]), group('g2', [cat('c3', 'g2', 3)])];

  it('merges a changed category nested in an otherwise partial group', () => {
    // The delta's group lists only the changed category; c1 must survive.
    const merged = mergeCategoryGroups(base, [group('g1', [cat('c2', 'g1', 200)])]);
    expect(merged).toEqual([group('g1', [cat('c1', 'g1', 1), cat('c2', 'g1', 200)]), group('g2', [cat('c3', 'g2', 3)])]);
  });

  it('updates group fields without touching its categories', () => {
    const merged = mergeCategoryGroups(base, [group('g2', [], { name: 'Renamed', hidden: true })]);
    expect(merged[1]).toEqual(group('g2', [cat('c3', 'g2', 3)], { name: 'Renamed', hidden: true }));
  });

  it('adds new groups and categories', () => {
    const merged = mergeCategoryGroups(base, [group('g3', [cat('c4', 'g3', 4)]), group('g1', [cat('c5', 'g1')])]);
    expect(merged.map((g) => [g.id, g.categories.map((c) => c.id)])).toEqual([
      ['g1', ['c1', 'c2', 'c5']],
      ['g2', ['c3']],
      ['g3', ['c4']],
    ]);
  });

  it('moves a category to the group it now belongs to', () => {
    const merged = mergeCategoryGroups(base, [group('g2', [cat('c1', 'g2', 1)])]);
    expect(merged.map((g) => [g.id, g.categories.map((c) => c.id)])).toEqual([
      ['g1', ['c2']],
      ['g2', ['c3', 'c1']],
    ]);
  });

  it('removes deleted categories and deleted groups with their categories', () => {
    const merged = mergeCategoryGroups(base, [
      group('g1', [cat('c2', 'g1', 2, true)]),
      group('g2', [], { deleted: true }),
    ]);
    expect(merged).toEqual([group('g1', [cat('c1', 'g1', 1)])]);
  });

  it('never mutates the snapshot', () => {
    const snapshot = structuredClone(base);
    mergeCategoryGroups(snapshot, [group('g2', [cat('c1', 'g2')]), group('g1', [cat('c2', 'g1', 0, true)])]);
    expect(snapshot).toEqual(base);
  });

  it('throws DeltaMergeError for a category whose group is unknown or inconsistent', () => {
    expect(() => mergeCategoryGroups(base, [group('g9', [cat('c1', 'g9')], { deleted: true })])).toThrow(
      DeltaMergeError
    );
    expect(() => mergeCategoryGroups(base, [group('g1', [cat('c1', 'g2')])])).toThrow(DeltaMergeError);
    expect(() => mergeCategoryGroups(base, [{ id: 'g1' } as never])).toThrow(DeltaMergeError);
  });

  it('counts groups plus categories', () => {
    expect(countCategoryEntities(base)).toBe(5);
  });
});

describe('mergeTransactions', () => {
  const sub = (id: string, amount: number, deleted = false) => ({ id, transaction_id: 'p', amount, deleted });
  const txn = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
    id,
    date,
    amount: -1000,
    approved: true,
    deleted: false,
    subtransactions: [] as ReturnType<typeof sub>[],
    ...extra,
  });

  it('upserts, deletes and keeps the date order of the full fetch', () => {
    const base = [txn('a', '2026-01-01'), txn('b', '2026-01-05'), txn('c', '2026-01-09')];
    const merged = mergeTransactions(base, [
      txn('d', '2026-01-03'),
      txn('c', '2026-01-02', { amount: -5 }),
      txn('b', '2026-01-05', { deleted: true }),
    ]);
    expect(merged.map((t) => [t.id, t.date])).toEqual([
      ['a', '2026-01-01'],
      ['c', '2026-01-02'],
      ['d', '2026-01-03'],
    ]);
  });

  it('replaces a changed transaction subtransactions wholesale', () => {
    const base = [txn('p', '2026-01-01', { subtransactions: [sub('s1', -500), sub('s2', -500)] })];
    const merged = mergeTransactions(base, [
      txn('p', '2026-01-01', { subtransactions: [sub('s3', -1000), sub('s1', -500, true)] }),
    ]);
    expect(merged[0]?.subtransactions).toEqual([sub('s3', -1000)]);
  });

  it('a split turned into a plain transaction loses its lines', () => {
    const base = [txn('p', '2026-01-01', { subtransactions: [sub('s1', -500), sub('s2', -500)] })];
    expect(mergeTransactions(base, [txn('p', '2026-01-01')])[0]?.subtransactions).toEqual([]);
  });

  it('applies the keep predicate to changed transactions only', () => {
    const base = [txn('a', '2026-01-01', { approved: false }), txn('b', '2026-01-02', { approved: false })];
    const merged = mergeTransactions(base, [txn('a', '2026-01-01', { approved: true })], (t) => !t.approved);
    expect(merged.map((t) => t.id)).toEqual(['b']);
  });

  it('withoutDeletedSubtransactions returns the same object when nothing is deleted', () => {
    const t = txn('p', '2026-01-01', { subtransactions: [sub('s1', -1)] });
    expect(withoutDeletedSubtransactions(t)).toBe(t);
  });

  it('counts transactions plus their subtransactions', () => {
    expect(countTransactionEntities([txn('p', 'd', { subtransactions: [sub('s', 1), sub('t', 1)] }), txn('q', 'd')])).toBe(4);
  });
});
