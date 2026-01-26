/**
 * Simple In-Memory Cache with TTL
 * 
 * Used to cache YNAB API responses that don't change frequently
 * (budgets, accounts, categories, payees).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache {
  private readonly store: Map<string, CacheEntry<unknown>> = new Map();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 300000) { // 5 minutes default
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new Error(`Invalid default TTL: ${defaultTtlMs}. TTL must be a positive finite number.`);
    }
    this.defaultTtlMs = defaultTtlMs;
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
      this.store.delete(key);
      return undefined;
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
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Delete a specific key from the cache.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Delete all keys matching a prefix.
   */
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.store.clear();
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
        this.store.delete(key);
        count++;
      }
    }
    
    return count;
  }
}
