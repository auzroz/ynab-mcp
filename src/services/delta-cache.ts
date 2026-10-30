/**
 * Delta-sync snapshot store.
 *
 * For each (budget, resource, query) key it keeps the merged full result of the
 * last read and the server_knowledge it reflects, so the next read can ask YNAB
 * only for what changed (last_knowledge_of_server) and merge that in (see
 * delta-merge.ts and YnabClient.snapshotRead). Snapshots are only an input to
 * that refresh: a read never returns one without asking YNAB first, which is
 * what makes them safe to keep across writes (a write leaves them in place and
 * the next read picks the write up as a delta).
 *
 * Owned by the per-user components next to Cache (see user-registry.ts), so in
 * HTTP mode all of a user's sessions share one store and users never share one.
 *
 * Memory is bounded per store (one per user):
 * - at most DELTA_MAX_SNAPSHOTS snapshots and DELTA_MAX_ENTITIES entities in
 *   total; past either, least recently used snapshots are evicted, and a single
 *   result larger than the entity cap is not kept at all;
 * - a snapshot unused for DELTA_IDLE_MS is dropped;
 * - a snapshot whose lineage began with a full fetch more than DELTA_MAX_AGE_MS
 *   ago is dropped, so every key is periodically re-read in full. This bounds
 *   how long any drift could survive if YNAB ever left a change out of a delta
 *   (for instance one that moves a transaction out of a filtered query).
 */

/** Max snapshots kept per user. */
export const DELTA_MAX_SNAPSHOTS = 32;
/** Max entities (accounts, categories, transactions + subtransactions, ...) kept per user. */
export const DELTA_MAX_ENTITIES = 20_000;
/** A snapshot unused for this long is dropped (30 minutes). */
export const DELTA_IDLE_MS = 30 * 60 * 1000;
/** A snapshot is re-read in full at least this often (1 hour). */
export const DELTA_MAX_AGE_MS = 60 * 60 * 1000;

export interface Snapshot<T = unknown> {
  /** The merged full result, shaped like the endpoint's response. */
  readonly data: T;
  /** The server_knowledge `data` reflects. */
  readonly knowledge: number;
  /** Entity count, for the memory bound. */
  readonly entities: number;
  /** When the full fetch this snapshot descends from was made. */
  readonly baseFetchedAt: number;
}

interface Entry {
  snapshot: Snapshot;
  lastUsedAt: number;
}

export interface DeltaCacheOptions {
  maxSnapshots?: number;
  maxEntities?: number;
  idleMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export class DeltaCache {
  // Map order is recency order: get() and set() move a key to the end.
  private readonly entries = new Map<string, Entry>();
  private totalEntities = 0;
  private readonly maxSnapshots: number;
  private readonly maxEntities: number;
  private readonly idleMs: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;

  constructor(opts: DeltaCacheOptions = {}) {
    this.maxSnapshots = opts.maxSnapshots ?? DELTA_MAX_SNAPSHOTS;
    this.maxEntities = opts.maxEntities ?? DELTA_MAX_ENTITIES;
    this.idleMs = opts.idleMs ?? DELTA_IDLE_MS;
    this.maxAgeMs = opts.maxAgeMs ?? DELTA_MAX_AGE_MS;
    this.clock = opts.now ?? Date.now;
    for (const [name, v] of Object.entries({
      maxSnapshots: this.maxSnapshots,
      maxEntities: this.maxEntities,
      idleMs: this.idleMs,
      maxAgeMs: this.maxAgeMs,
    })) {
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid delta cache ${name}: ${v}`);
    }
  }

  /** The clock snapshots are timed with (baseFetchedAt). */
  now(): number {
    return this.clock();
  }

  /** The live snapshot for a key, if any (marks it recently used). */
  get<T>(key: string): Snapshot<T> | undefined {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastUsedAt = this.clock();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.snapshot as Snapshot<T>;
  }

  /**
   * Store `next` for `key` unless a newer snapshot got there first. `base` is the
   * snapshot `next` was merged onto (undefined for a full fetch): it is replaced
   * even at equal knowledge, while any other snapshot is only replaced by a
   * strictly newer one. Concurrent refreshes of one key therefore never move it
   * back to older knowledge. Returns whether `next` was stored.
   */
  offer(key: string, next: Snapshot, base?: Snapshot): boolean {
    this.sweep();
    const current = this.entries.get(key);
    if (current && current.snapshot !== base && current.snapshot.knowledge >= next.knowledge) {
      return false;
    }
    if (current) this.remove(key, current);
    if (next.entities > this.maxEntities) return false;
    this.entries.set(key, { snapshot: next, lastUsedAt: this.clock() });
    this.totalEntities += next.entities;
    this.evictOverflow();
    return this.entries.get(key)?.snapshot === next;
  }

  /** Drop one key's snapshot, but only if it is still `expected` (when given). */
  delete(key: string, expected?: Snapshot): boolean {
    const entry = this.entries.get(key);
    if (!entry || (expected !== undefined && entry.snapshot !== expected)) return false;
    this.remove(key, entry);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.totalEntities = 0;
  }

  /** Number of snapshots kept. */
  size(): number {
    return this.entries.size;
  }

  /** Number of entities across all snapshots. */
  entityCount(): number {
    return this.totalEntities;
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalEntities -= entry.snapshot.entities;
  }

  /** Drop idle and over-age snapshots (lazy, on every access; at most maxSnapshots entries). */
  private sweep(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt >= this.idleMs || now - entry.snapshot.baseFetchedAt >= this.maxAgeMs) {
        this.remove(key, entry);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxSnapshots || this.totalEntities > this.maxEntities) {
      const oldest = this.entries.entries().next();
      if (oldest.done === true) break;
      const [key, entry] = oldest.value;
      this.remove(key, entry);
    }
  }
}
