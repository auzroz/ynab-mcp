/**
 * express-rate-limit's `Store` on the shared rate-limit tables (#67b,
 * `RATE_LIMIT_STORE=postgres`), handed to every authorization-server limiter
 * and the Client ID Metadata Document fetch budget through the
 * `LimiterStoreFactory` seam (rate-limiters.ts). One store per limiter, under
 * the limiter's name, so two limiters never count into each other's windows.
 *
 * The windows are the in-memory store's: a fixed window per key that starts
 * at the key's first hit. The count is the database's, so every replica sees
 * every other replica's hits.
 *
 * Fail closed: when the database can't answer in time, a hit counts as over
 * any limit, with a window of SHARED_LIMIT_RETRY_AFTER_MS. Every limiter then
 * answers its usual 429 with `Retry-After: 5`, the /register host limit
 * refuses the registration, and the metadata-document budget refuses the
 * fetch. Nothing is let through on a budget of this process's own.
 */

import type { IncrementResponse, Options, Store, ClientRateLimitInfo } from 'express-rate-limit';
import type { LimiterStoreFactory } from './rate-limiters.js';
import { SHARED_LIMIT_RETRY_AFTER_MS, type SharedLimitStore } from '../storage/shared-limits.js';

/** The window a store uses until express-rate-limit's init() has run (it isn't awaited). */
const DEFAULT_WINDOW_MS = 60_000;

export class SharedWindowStore implements Store {
  /** Keys are shared across processes (express-rate-limit's double-count check reads this). */
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = DEFAULT_WINDOW_MS;

  constructor(
    private readonly store: SharedLimitStore,
    private readonly limiter: string
  ) {
    this.prefix = `${limiter}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      const { hits, resetAt } = await this.store.hit(this.limiter, key, this.windowMs);
      return { totalHits: hits, resetTime: new Date(resetAt) };
    } catch {
      // Unavailable (logged by the store): over every limit, for a short window.
      return { totalHits: Number.MAX_SAFE_INTEGER, resetTime: new Date(Date.now() + SHARED_LIMIT_RETRY_AFTER_MS) };
    }
  }

  async decrement(key: string): Promise<void> {
    // Not taking a hit back only ever counts against the caller.
    await this.store.unhit(this.limiter, key).catch(() => undefined);
  }

  async resetKey(key: string): Promise<void> {
    await this.store.resetHits(this.limiter, key);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const window = await this.store.getHits(this.limiter, key);
    return window ? { totalHits: window.hits, resetTime: new Date(window.resetAt) } : undefined;
  }
}

/** The factory as-router.ts and client-id-metadata.ts take: one store per limiter name. */
export function sharedLimiterStores(store: SharedLimitStore): LimiterStoreFactory {
  return (name) => new SharedWindowStore(store, name);
}
