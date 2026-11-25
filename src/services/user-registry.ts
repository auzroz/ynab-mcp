/**
 * Per-user state shared by all of a user's MCP requests (HTTP mode).
 *
 * YNAB rate-limits per access token (200 requests/hour), so every request of one
 * user must draw on one RateLimiter: per-request (or per-client) limiters would
 * give a user several independent budgets. The requests also share one Cache,
 * one DeltaCache (delta-sync snapshots), the per-client usage report, the
 * transaction feed state and (when there is no durable storage: stdio,
 * header mode) a memory audit store, so ynab_audit_log shows the user's writes
 * from every client and a snapshot one request built saves the next a full
 * fetch. Each request records into the audit log with its own client and
 * request ids (src/services/audit-log.ts). /mcp is stateless
 * (ADR-0001), so each request builds its own YnabClient on top (its read-only
 * flag is computed per request), and the user's components live here between
 * requests: every request holds a lease while it runs (released per D5).
 */

import { createHash } from 'node:crypto';
import { RateLimiter, type RequestLimiter } from './rate-limiter.js';
import { Cache } from './cache.js';
import { DeltaCache } from './delta-cache.js';
import { MemoryAuditStore } from '../storage/audit-rows.js';
import { ClientUsage } from './client-usage.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { WriteLimiter, type WriteCap } from './write-limiter.js';
import { WRITE_LIMIT_DEFAULT_PER_HOUR } from '../config/write-limit.js';
import { ByteBudget, DEFAULT_USER_CACHE_BYTES } from './byte-budget.js';
import type { TransactionFeedState } from './ynab-client.js';

/** The rate limiter's refill window: an idle hour refills any bucket completely. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** How often the idle sweep also prunes expired cache entries (#58). */
export const CACHE_PRUNE_INTERVAL_MS = 60 * 1000;

/** Default bound on retained users (see UserRegistryOptions.maxEntries). */
export const DEFAULT_MAX_USER_ENTRIES = 10_000;

/**
 * Refused writes (read-only mode, a read-only grant) recorded in the audit log
 * per user per hour (#60a). Such a refusal costs no YNAB request and no write
 * slot, so without a bound a looping client could add a row per call; past it
 * the refusals still happen, unrecorded, and one stderr line says so.
 */
export const AUDITED_DENIALS_PER_HOUR = 20;

/** The state one user's requests share. */
export interface UserComponents {
  /** The user's YNAB request budget: this process's own, or shared by every replica (#67c). */
  readonly rateLimiter: RequestLimiter;
  readonly cache: Cache;
  readonly deltaCache: DeltaCache;
  /**
   * The user's audit rows when there is no durable storage: stdio and header
   * mode (D-7c). Kept while the user's entry is; oauth mode writes to the
   * storage driver instead.
   */
  readonly auditStore: MemoryAuditStore;
  /** Which of the user's clients sent their YNAB requests (#58), for ynab_rate_limit_status. */
  readonly clientUsage: ClientUsage;
  /** How many refused writes the audit log still records this hour (#60a; see AUDITED_DENIALS_PER_HOUR). */
  readonly auditedDenials: WriteLimiter;
  /** Fails this user's YNAB calls fast while YNAB is failing (#58); per user, never shared. */
  readonly breaker: CircuitBreaker;
  /** The user's write cap (#61c), shared by all their requests like the rate limiter; across replicas with RATE_LIMIT_STORE=postgres (#67). */
  readonly writeLimiter: WriteCap;
  /**
   * What YNAB has told us about the transaction change feed (a rejected
   * since_date), kept per user so a new request's YnabClient does not repeat a
   * call YNAB already refused.
   */
  readonly feedState: TransactionFeedState;
}

/** Build a fresh set of per-user components. */
export function createUserComponents(
  limits: {
    rateLimitPerHour: number;
    rateLimitMaxWaitMs?: number | undefined;
    cacheTtlMs: number;
    /** Write requests per hour (default 20; 0 = no cap). */
    writeLimitPerHour?: number | undefined;
    /** Cap on the serialized size of the user's cache and snapshots together (default 8 MiB). */
    cacheMaxBytes?: number | undefined;
  },
  now: () => number = Date.now,
  /** The user's limiter when it lives elsewhere (RATE_LIMIT_STORE=postgres); in-process otherwise. */
  rateLimiter?: RequestLimiter,
  /** The user's write cap when it lives elsewhere (RATE_LIMIT_STORE=postgres); in-process otherwise. */
  writeLimiter?: WriteCap
): UserComponents {
  // One byte budget for both stores, so a user's snapshots and cached
  // responses together stay under it (#58).
  const budget = new ByteBudget(limits.cacheMaxBytes ?? DEFAULT_USER_CACHE_BYTES);
  return {
    rateLimiter: rateLimiter ?? new RateLimiter(limits.rateLimitPerHour, now, limits.rateLimitMaxWaitMs),
    cache: new Cache(limits.cacheTtlMs, budget),
    deltaCache: new DeltaCache({ now, budget }),
    auditStore: new MemoryAuditStore(),
    clientUsage: new ClientUsage(now),
    auditedDenials: new WriteLimiter(AUDITED_DENIALS_PER_HOUR, now),
    breaker: new CircuitBreaker({ now }),
    writeLimiter: writeLimiter ?? new WriteLimiter(limits.writeLimitPerHour ?? WRITE_LIMIT_DEFAULT_PER_HOUR, now),
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
  /** Write requests per user per hour (default 20; 0 = no cap). */
  writeLimitPerHour?: number | undefined;
  /** Per-user cap on cached bytes (see createUserComponents); defaults to 8 MiB. */
  cacheMaxBytes?: number | undefined;
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
  /**
   * Builds a user's rate limiter (RATE_LIMIT_STORE=postgres: one on the
   * shared bucket, #67c). Absent: an in-process RateLimiter per user.
   */
  rateLimiterFor?: ((userKey: string) => RequestLimiter) | undefined;
  /** Builds a user's write cap (RATE_LIMIT_STORE=postgres: the shared one, #67). Absent: in-process. */
  writeLimiterFor?: ((userKey: string) => WriteCap) | undefined;
}

interface Entry {
  components: UserComponents;
  liveLeases: number;
  /** When the entry was last acquired or released. */
  lastUsedAt: number;
}

export class UserRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: {
    rateLimitPerHour: number;
    rateLimitMaxWaitMs?: number | undefined;
    cacheTtlMs: number;
    writeLimitPerHour?: number | undefined;
    cacheMaxBytes?: number | undefined;
  };
  private readonly idleEvictionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly rateLimiterFor: ((userKey: string) => RequestLimiter) | undefined;
  private readonly writeLimiterFor: ((userKey: string) => WriteCap) | undefined;
  private lastPrunedAt = 0;

  constructor(opts: UserRegistryOptions) {
    this.limits = {
      rateLimitPerHour: opts.rateLimitPerHour,
      rateLimitMaxWaitMs: opts.rateLimitMaxWaitMs,
      cacheTtlMs: opts.cacheTtlMs,
      writeLimitPerHour: opts.writeLimitPerHour,
      cacheMaxBytes: opts.cacheMaxBytes,
    };
    this.idleEvictionMs = opts.idleEvictionMs ?? RATE_LIMIT_WINDOW_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_USER_ENTRIES;
    this.now = opts.now ?? Date.now;
    this.rateLimiterFor = opts.rateLimiterFor;
    this.writeLimiterFor = opts.writeLimiterFor;
  }

  /** Take a hold on the user's components for a request, creating them if needed. */
  acquire(userKey: string): UserLease {
    const now = this.now();
    this.sweep(now);
    let entry = this.entries.get(userKey);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.evictLeastRecentlyUsedIdle();
      entry = {
        components: createUserComponents(
          this.limits,
          this.now,
          this.rateLimiterFor?.(userKey),
          this.writeLimiterFor?.(userKey)
        ),
        liveLeases: 0,
        lastUsedAt: now,
      };
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

  /**
   * Forget a user's components now (#53c, after `ynab_disconnect` erased the
   * account): the cache, delta snapshots, memory audit rows, limiter and
   * usage report. Leases still held (the disconnecting request's own) keep
   * the dropped set until they are released; their release touches only that
   * detached entry. The user's next request gets a fresh set.
   */
  drop(userKey: string): void {
    const entry = this.entries.get(userKey);
    if (entry === undefined) return;
    this.entries.delete(userKey);
    entry.components.cache.clear();
    entry.components.deltaCache.clear();
    // Rows are recorded under the registry key (header mode); oauth mode keeps none here.
    entry.components.auditStore.deleteUser(userKey);
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
   * never grants capacity. A shared limiter (#67c) keeps its budget in the
   * database, so dropping its entry grants nothing and the check is skipped.
   * Lazy (run on acquire): entries only accumulate as
   * new requests arrive. The same sweep prunes expired cache entries and idle
   * snapshots (at most once a CACHE_PRUNE_INTERVAL_MS), so a user's expired
   * data does not sit in memory until their next read.
   */
  private sweep(now: number): void {
    if (now - this.lastPrunedAt >= CACHE_PRUNE_INTERVAL_MS) {
      this.lastPrunedAt = now;
      for (const entry of this.entries.values()) {
        entry.components.cache.prune();
        entry.components.deltaCache.prune();
      }
    }
    for (const [key, entry] of this.entries) {
      if (entry.liveLeases > 0 || now - entry.lastUsedAt < this.idleEvictionMs) continue;
      const status = entry.components.rateLimiter.getStatus();
      if (status.store === 'memory' && status.available < status.limit) continue;
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
