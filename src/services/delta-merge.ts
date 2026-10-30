/**
 * Delta merges for YNAB's last_knowledge_of_server responses.
 *
 * A delta response carries only the entities changed since the given knowledge;
 * deleted ones come back with `deleted: true`. These pure functions apply such a
 * delta to the full set a previous read returned, giving the set a full fetch
 * would return now. They never mutate their inputs.
 *
 * Assumptions (from the YNAB API docs and how 0.4.x reads them):
 * - full (non-delta) fetches return no deleted entities, so a merged set drops
 *   every entity a delta reports as deleted;
 * - a changed transaction or scheduled transaction carries its complete set of
 *   subtransactions, so it replaces the old one wholesale (subtransactions
 *   reported as deleted inside it are dropped, as a full fetch would);
 * - a changed category comes back nested in the group it now belongs to.
 *
 * Anything that contradicts these (an entity without an id, a category whose
 * group is unknown, a missing array) throws DeltaMergeError, and the caller
 * falls back to a full fetch.
 */

/** A delta that can't be applied to the snapshot; the caller does a full fetch. */
export class DeltaMergeError extends Error {
  constructor(reason: string) {
    super(`Delta merge failed: ${reason}`);
    this.name = 'DeltaMergeError';
  }
}

interface Deletable {
  deleted?: boolean | undefined;
}

export interface MergeOptions<T> {
  /** Applied to each changed (non-deleted) entity before it is stored. */
  prepare?: ((entity: T) => T) | undefined;
  /**
   * Whether a changed entity still belongs in the result set. Entities a delta
   * reports that fail it are removed like deleted ones, so a change that moves
   * an entity out of the query's filter (e.g. re-dating it before since_date)
   * can't leave it behind.
   */
  keep?: ((entity: T) => boolean) | undefined;
}

function requireArray<T>(value: unknown, what: string): readonly T[] {
  if (!Array.isArray(value)) throw new DeltaMergeError(`${what} is not an array`);
  return value as T[];
}

/**
 * Upsert every changed entity by key and drop deleted ones. Existing entities
 * keep their position; new ones are appended in delta order.
 */
export function mergeBy<T extends Deletable>(
  base: readonly T[],
  delta: readonly T[],
  key: (entity: T) => unknown,
  opts: MergeOptions<T> = {}
): T[] {
  requireArray(base, 'snapshot');
  requireArray(delta, 'delta');
  const out = base.slice();
  const index = new Map<string, number>();
  out.forEach((entity, i) => {
    index.set(String(key(entity)), i);
  });
  const removed = new Set<string>();

  for (const raw of delta) {
    const k = raw === null || typeof raw !== 'object' ? undefined : key(raw);
    if (typeof k !== 'string' || k === '') throw new DeltaMergeError('entity without a key');
    const at = index.get(k);
    if (raw.deleted === true || (opts.keep !== undefined && !opts.keep(raw))) {
      if (at !== undefined) removed.add(k);
      continue;
    }
    const entity = opts.prepare ? opts.prepare(raw) : raw;
    removed.delete(k);
    if (at !== undefined) {
      out[at] = entity;
    } else {
      index.set(k, out.length);
      out.push(entity);
    }
  }

  return removed.size === 0 ? out : out.filter((entity) => !removed.has(String(key(entity))));
}

/** mergeBy keyed by `id` (accounts, payees, transactions, scheduled transactions). */
export function mergeById<T extends Deletable & { id: string }>(
  base: readonly T[],
  delta: readonly T[],
  opts: MergeOptions<T> = {}
): T[] {
  return mergeBy(base, delta, (e) => e.id, opts);
}

/**
 * The order a full fetch used for `key`: 1 ascending, -1 descending, 0 unknown
 * (fewer than two distinct keys, or not sorted by it).
 */
function sortDirection<T>(items: readonly T[], key: (item: T) => string): 1 | -1 | 0 {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < items.length; i++) {
    const a = key(items[i - 1] as T);
    const b = key(items[i] as T);
    if (a > b) ascending = false;
    if (a < b) descending = false;
  }
  if (ascending && descending) return 0;
  if (ascending) return 1;
  if (descending) return -1;
  return 0;
}

/**
 * Re-sort a merged list the way the full fetch it descends from was sorted
 * (YNAB returns transactions by date and months by month). The sort is stable,
 * so entities with equal keys keep the snapshot's order, with new ones after
 * existing ones. When the snapshot is too small to tell, the delta's order is
 * used, then `fallback` (0 keeps the merged order).
 */
export function orderLike<T>(
  base: readonly T[],
  merged: T[],
  key: (item: T) => string,
  delta: readonly T[] = [],
  fallback: 1 | -1 | 0 = 0
): T[] {
  const direction = sortDirection(base, key) || sortDirection(delta, key) || fallback;
  if (direction === 0) return merged;
  return merged.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : (ka < kb ? -1 : 1) * direction;
  });
}

interface WithSubtransactions {
  subtransactions?: readonly Deletable[] | undefined;
}

/** Drop subtransactions a delta reports as deleted (a full fetch omits them). */
export function withoutDeletedSubtransactions<T extends WithSubtransactions>(entity: T): T {
  const subs = entity.subtransactions;
  if (!Array.isArray(subs) || !subs.some((s: Deletable) => s.deleted === true)) return entity;
  return { ...entity, subtransactions: subs.filter((s: Deletable) => s.deleted !== true) };
}

interface TransactionLike extends Deletable, WithSubtransactions {
  id: string;
  date: string;
}

/**
 * Merge a TransactionDetail delta: a changed transaction replaces the old one
 * including its subtransactions; the result keeps the full fetch's date order
 * (oldest first when the snapshot and delta can't tell). Within one date, order
 * is the snapshot's with new transactions last, which may differ from YNAB's.
 */
export function mergeTransactions<T extends TransactionLike>(
  base: readonly T[],
  delta: readonly T[],
  keep?: (txn: T) => boolean
): T[] {
  const merged = mergeById(base, delta, { prepare: withoutDeletedSubtransactions, keep });
  // YNAB lists transactions oldest first.
  return orderLike(base, merged, (t) => t.date, delta, 1);
}

interface CategoryLike extends Deletable {
  id: string;
  category_group_id?: string | undefined;
}

interface GroupLike<C extends CategoryLike> extends Deletable {
  id: string;
  categories: C[];
}

/**
 * Merge a categories delta: groups are upserted by id (keeping their position),
 * then each changed category is removed from wherever it was and placed in the
 * group it now belongs to (in place when it didn't move, appended when it did),
 * then deleted groups are dropped with their categories.
 */
export function mergeCategoryGroups<C extends CategoryLike, G extends GroupLike<C>>(
  base: readonly G[],
  delta: readonly G[]
): G[] {
  requireArray(base, 'snapshot');
  requireArray(delta, 'delta');
  const groups: G[] = base.map((g) => ({ ...g, categories: g.categories.slice() }));
  const groupIndex = new Map<string, number>();
  groups.forEach((g, i) => groupIndex.set(g.id, i));

  // 1. Group fields (name, hidden, ...) and new groups.
  for (const dg of delta) {
    if (dg === null || typeof dg !== 'object' || typeof dg.id !== 'string' || dg.id === '') {
      throw new DeltaMergeError('category group without an id');
    }
    requireArray(dg.categories, 'category group categories');
    if (dg.deleted === true) continue;
    const at = groupIndex.get(dg.id);
    if (at !== undefined) {
      groups[at] = { ...dg, categories: (groups[at] as G).categories };
    } else {
      groupIndex.set(dg.id, groups.length);
      groups.push({ ...dg, categories: [] });
    }
  }

  // 2. Categories, which may have moved between groups.
  const location = new Map<string, G>();
  for (const g of groups) for (const c of g.categories) location.set(c.id, g);
  for (const dg of delta) {
    for (const dc of dg.categories) {
      if (dc === null || typeof dc !== 'object' || typeof dc.id !== 'string' || dc.id === '') {
        throw new DeltaMergeError('category without an id');
      }
      const from = location.get(dc.id);
      const fromAt = from ? from.categories.findIndex((c) => c.id === dc.id) : -1;
      if (dc.deleted === true) {
        if (from) from.categories.splice(fromAt, 1);
        location.delete(dc.id);
        continue;
      }
      const targetId = dc.category_group_id ?? dg.id;
      if (targetId !== dg.id) throw new DeltaMergeError('category nested under another group');
      const targetAt = groupIndex.get(targetId);
      const target = targetAt === undefined ? undefined : groups[targetAt];
      if (!target) throw new DeltaMergeError('category in an unknown group');
      if (from === target) {
        target.categories[fromAt] = dc;
      } else {
        if (from) from.categories.splice(fromAt, 1);
        target.categories.push(dc);
      }
      location.set(dc.id, target);
    }
  }

  // 3. Deleted groups.
  const deletedGroups = new Set(delta.filter((g) => g.deleted === true).map((g) => g.id));
  return deletedGroups.size === 0 ? groups : groups.filter((g) => !deletedGroups.has(g.id));
}

/** Number of entities in a category group list (groups plus their categories). */
export function countCategoryEntities(groups: readonly GroupLike<CategoryLike>[]): number {
  return groups.reduce((n, g) => n + 1 + g.categories.length, 0);
}

/** Number of entities in a transaction list (transactions plus subtransactions). */
export function countTransactionEntities(txns: readonly WithSubtransactions[]): number {
  return txns.reduce((n, t) => n + 1 + (Array.isArray(t.subtransactions) ? t.subtransactions.length : 0), 0);
}
