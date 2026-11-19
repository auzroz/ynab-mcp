/**
 * Simple In-Memory Cache with TTL
 * 
 * Used to cache YNAB API responses that don't change frequently
 * (budgets, accounts, categories, payees).
 *
 * Given a ByteBudget (the per-user components do, see user-registry.ts) it also
 * counts the serialized size of what it stores against that shared budget, and
 * is one of the stores the budget evicts from, least recently used first.
 */

import { serializedBytes, type ByteBudget, type ByteBudgetMember } from './byte-budget.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  /** Serialized size counted against the budget (0 without one). */
  bytes: number;
  /** Recency stamp from the budget (0 without one). */
  tick: number;
}

export class Cache implements ByteBudgetMember {
  private readonly store: Map<string, CacheEntry<unknown>> = new Map();
  private readonly defaultTtlMs: number;
  // See generation(). Lives here rather than on a YnabClient because in HTTP
  // mode all of a user's sessions (one client each) share one cache.
  private invalidations = 0;

  private readonly budget: ByteBudget | undefined;

  constructor(defaultTtlMs: number = 300000, budget?: ByteBudget) { // 5 minutes default
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new Error(`Invalid default TTL: ${defaultTtlMs}. TTL must be a positive finite number.`);
    }
    this.defaultTtlMs = defaultTtlMs;
    this.budget = budget;
    budget?.register(this);
  }

  /**
   * Get a value from the cache.
   * Returns undefined if not found or expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    
    if (entry === undefined) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.remove(key, entry);
      return undefined;
    }

    // Reads count as use: the Map's order is least recently used first.
    if (this.budget !== undefined) {
      this.store.delete(key);
      entry.tick = this.budget.tick();
      this.store.set(key, entry);
    }
    return entry.value as T;
  }

  /**
   * Set a value in the cache.
   * Guards against non-finite TTLs to prevent never-expiring entries.
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    // Guard against NaN/Infinity to prevent never-expiring entries
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`Invalid TTL: ${ttl}. TTL must be a positive finite number.`);
    }
    const expiresAt = Date.now() + ttl;
    const previous = this.store.get(key);
    if (previous !== undefined) this.remove(key, previous);
    if (this.budget === undefined) {
      this.store.set(key, { value, expiresAt, bytes: 0, tick: 0 });
      return;
    }
    const bytes = serializedBytes(value);
    // Bigger than the whole budget: not kept (and the old value is gone).
    if (!this.budget.fits(bytes)) return;
    this.store.set(key, { value, expiresAt, bytes, tick: this.budget.tick() });
    this.budget.add(bytes);
    this.budget.enforce();
  }

  private remove(key: string, entry: CacheEntry<unknown>): void {
    this.store.delete(key);
    this.budget?.sub(entry.bytes);
  }

  budgetOldestTick(): number | undefined {
    const first = this.store.values().next();
    return first.done === true ? undefined : first.value.tick;
  }

  budgetEvictOldest(): void {
    const first = this.store.entries().next();
    if (first.done !== true) this.remove(first.value[0], first.value[1]);
  }

  /** Bytes this cache's user holds across the shared budget, and its cap; undefined without a budget. */
  byteUsage(): { bytes: number; maxBytes: number } | undefined {
    return this.budget === undefined ? undefined : { bytes: this.budget.used, maxBytes: this.budget.maxBytes };
  }

  /**
   * Delete a specific key from the cache.
   */
  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) return false;
    this.remove(key, entry);
    return true;
  }

  /**
   * Delete all keys matching a prefix.
   */
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        this.remove(key, entry);
        count++;
      }
    }
    return count;
  }

  /**
   * Counter bumped by bumpGeneration(). A read that started before a bump must
   * not cache its (possibly stale) result, so an in-flight request can't
   * restore what an invalidation just dropped.
   */
  generation(): number {
    return this.invalidations;
  }

  bumpGeneration(): void {
    this.invalidations++;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    for (const [key, entry] of this.store) this.remove(key, entry);
  }

  /**
   * Get the number of entries in the cache (including expired).
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Remove all expired entries.
   */
  prune(): number {
    const now = Date.now();
    let count = 0;
    
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.remove(key, entry);
        count++;
      }
    }
    
    return count;
  }
}
