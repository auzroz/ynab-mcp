/**
 * Per-user state shared by all of a user's MCP requests (HTTP mode).
 *
 * YNAB rate-limits per access token (200 requests/hour), so every request of one
 * user must draw on one RateLimiter: per-request (or per-client) limiters would
 * give a user several independent budgets. The requests also share one Cache,
 * one DeltaCache (delta-sync snapshots), one AuditLog and the transaction feed
 * state, so ynab_audit_log shows the user's writes from every client and a
 * snapshot one request built saves the next a full fetch. /mcp is stateless
 * (ADR-0001), so each request builds its own YnabClient on top (its read-only
 * flag is computed per request), and the user's components live here between
 * requests: every request holds a lease while it runs (released per D5).
 */

import { createHash } from 'node:crypto';
import { RateLimiter } from './rate-limiter.js';
import { Cache } from './cache.js';
import { DeltaCache } from './delta-cache.js';
import { AuditLog } from './audit-log.js';
import type { TransactionFeedState } from './ynab-client.js';

/** The rate limiter's refill window: an idle hour refills any bucket completely. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Default bound on retained users (see UserRegistryOptions.maxEntries). */
export const DEFAULT_MAX_USER_ENTRIES = 10_000;

/** The state one user's requests share. */
export interface UserComponents {
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly deltaCache: DeltaCache;
  readonly auditLog: AuditLog;
  /**
   * What YNAB has told us about the transaction change feed (a rejected
   * since_date), kept per user so a new request's YnabClient does not repeat a
   * call YNAB already refused.
   */
  readonly feedState: TransactionFeedState;
}

/** Build a fresh set of per-user components. */
export function createUserComponents(
  limits: { rateLimitPerHour: number; rateLimitMaxWaitMs?: number | undefined; cacheTtlMs: number },
  now: () => number = Date.now
): UserComponents {
  return {
    rateLimiter: new RateLimiter(limits.rateLimitPerHour, now, limits.rateLimitMaxWaitMs),
    cache: new Cache(limits.cacheTtlMs),
    deltaCache: new DeltaCache({ now }),
    auditLog: new AuditLog(),
    feedState: { sinceDateRejected: false },
  };
}

/**
 * Registry key for a header-mode user: a SHA-256 digest of the effective YNAB
 * token, so one token's requests share state and the raw token is never kept as
 * a key. (oauth mode keys by the YNAB user id from the verified MCP token.)
 */
export function headerUserKey(ynabToken: string): string {
  return createHash('sha256').update(ynabToken).digest('hex');
}

/** One request's hold on its user's components; released when the request is done (ADR-0001 D5). */
export interface UserLease {
  readonly components: UserComponents;
  /** Idempotent, so every path that ends a request can call it. */
  release(): void;
}

export interface UserRegistryOptions {
  rateLimitPerHour: number;
  rateLimitMaxWaitMs?: number | undefined;
  cacheTtlMs: number;
  /** Minimum time an entry without leases is kept. Defaults to the rate-limit window. */
  idleEvictionMs?: number;
  /**
   * Bound on retained users. Header mode accepts any token, so without it a
   * client cycling through made-up tokens could grow the registry for an hour
   * per token. Past it, the least recently used entry without live leases is
   * dropped early; that may hand its user a fresh limiter, but YNAB enforces its
   * own per-token limit, so only that user's own quota is at stake. Entries with
   * live leases are never dropped, so those are bounded only by the number of
   * requests in flight.
   */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  components: UserComponents;
  liveLeases: number;
  /** When the entry was last acquired or released. */
  lastUsedAt: number;
}

export class UserRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: { rateLimitPerHour: number; rateLimitMaxWaitMs?: number | undefined; cacheTtlMs: number };
  private readonly idleEvictionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: UserRegistryOptions) {
    this.limits = { rateLimitPerHour: opts.rateLimitPerHour, rateLimitMaxWaitMs: opts.rateLimitMaxWaitMs, cacheTtlMs: opts.cacheTtlMs };
    this.idleEvictionMs = opts.idleEvictionMs ?? RATE_LIMIT_WINDOW_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_USER_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /** Take a hold on the user's components for a request, creating them if needed. */
  acquire(userKey: string): UserLease {
    const now = this.now();
    this.sweep(now);
    let entry = this.entries.get(userKey);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.evictLeastRecentlyUsedIdle();
      entry = { components: createUserComponents(this.limits, this.now), liveLeases: 0, lastUsedAt: now };
      this.entries.set(userKey, entry);
    }
    entry.liveLeases++;
    entry.lastUsedAt = now;

    const held = entry;
    let released = false;
    return {
      components: held.components,
      release: () => {
        if (released) return;
        released = true;
        held.liveLeases--;
        held.lastUsedAt = this.now();
      },
    };
  }

  /** Number of users with retained state (live or within the eviction window). */
  get size(): number {
    return this.entries.size;
  }

  /** Live leases on a user's entry (0 when it has none or no entry). */
  leases(userKey: string): number {
    return this.entries.get(userKey)?.liveLeases ?? 0;
  }

  /**
   * Drop entries with no live leases that have been idle for the eviction
   * window. Dropping one as soon as its last request finished would hand the
   * user a fresh rate limiter on the next one; the full-bucket check
   * additionally keeps an entry whose limiter is still refilling, so evicting
   * never grants capacity. Lazy (run on acquire): entries only accumulate as
   * new requests arrive.
   */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.liveLeases > 0 || now - entry.lastUsedAt < this.idleEvictionMs) continue;
      const status = entry.components.rateLimiter.getStatus();
      if (status.available < status.limit) continue;
      this.entries.delete(key);
    }
  }

  private evictLeastRecentlyUsedIdle(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.liveLeases === 0 && entry.lastUsedAt < oldestAt) {
        oldestKey = key;
        oldestAt = entry.lastUsedAt;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
