/**
 * Per-user state shared by all of a user's MCP sessions (HTTP mode).
 *
 * YNAB rate-limits per access token (200 requests/hour), so every session of one
 * user must draw on one RateLimiter: per-session limiters would give a user with
 * several clients (or a client that reconnects) several independent budgets.
 * The sessions also share one Cache, one DeltaCache (delta-sync snapshots) and
 * one AuditLog, so ynab_audit_log shows the user's writes from every session and
 * a snapshot one session built saves the others a full fetch. Each session still
 * builds its own YnabClient on top (its read-only flag and its record of the
 * last server_knowledge it saw are its own).
 */

import { createHash } from 'node:crypto';
import { RateLimiter } from './rate-limiter.js';
import { Cache } from './cache.js';
import { DeltaCache } from './delta-cache.js';
import { AuditLog } from './audit-log.js';

/** The rate limiter's refill window: an idle hour refills any bucket completely. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Default bound on retained users (see UserRegistryOptions.maxEntries). */
export const DEFAULT_MAX_USER_ENTRIES = 10_000;

/** The state one user's sessions share. */
export interface UserComponents {
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly deltaCache: DeltaCache;
  readonly auditLog: AuditLog;
}

/** Build a fresh set of per-user components. */
export function createUserComponents(
  limits: { rateLimitPerHour: number; cacheTtlMs: number },
  now: () => number = Date.now
): UserComponents {
  return {
    rateLimiter: new RateLimiter(limits.rateLimitPerHour, now),
    cache: new Cache(limits.cacheTtlMs),
    deltaCache: new DeltaCache({ now }),
    auditLog: new AuditLog(),
  };
}

/**
 * Registry key for a header-mode user: a SHA-256 digest of the effective YNAB
 * token, so one token's sessions share state and the raw token is never kept as
 * a key. (oauth mode keys by the YNAB user id from the verified MCP token.)
 */
export function headerUserKey(ynabToken: string): string {
  return createHash('sha256').update(ynabToken).digest('hex');
}

/** One session's hold on its user's components; release it when the session closes. */
export interface UserLease {
  readonly components: UserComponents;
  /** Idempotent, so every session-teardown path can call it. */
  release(): void;
}

export interface UserRegistryOptions {
  rateLimitPerHour: number;
  cacheTtlMs: number;
  /** Minimum time an entry without sessions is kept. Defaults to the rate-limit window. */
  idleEvictionMs?: number;
  /**
   * Bound on retained users. Header mode accepts any token, so without it a
   * client cycling through made-up tokens could grow the registry for an hour
   * per token. Past it, the least recently used entry without live sessions is
   * dropped early; that may hand its user a fresh limiter, but YNAB enforces its
   * own per-token limit, so only that user's own quota is at stake. Entries with
   * live sessions are never dropped, so those are bounded only by the number of
   * live sessions.
   */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  components: UserComponents;
  liveSessions: number;
  /** When the entry was last acquired or released. */
  lastUsedAt: number;
}

export class UserRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: { rateLimitPerHour: number; cacheTtlMs: number };
  private readonly idleEvictionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: UserRegistryOptions) {
    this.limits = { rateLimitPerHour: opts.rateLimitPerHour, cacheTtlMs: opts.cacheTtlMs };
    this.idleEvictionMs = opts.idleEvictionMs ?? RATE_LIMIT_WINDOW_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_USER_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /** Take a hold on the user's components for a new session, creating them if needed. */
  acquire(userKey: string): UserLease {
    const now = this.now();
    this.sweep(now);
    let entry = this.entries.get(userKey);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.evictLeastRecentlyUsedIdle();
      entry = { components: createUserComponents(this.limits, this.now), liveSessions: 0, lastUsedAt: now };
      this.entries.set(userKey, entry);
    }
    entry.liveSessions++;
    entry.lastUsedAt = now;

    const held = entry;
    let released = false;
    return {
      components: held.components,
      release: () => {
        if (released) return;
        released = true;
        held.liveSessions--;
        held.lastUsedAt = this.now();
      },
    };
  }

  /** Number of users with retained state (live or within the eviction window). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop entries with no live sessions that have been idle for the eviction
   * window. Dropping one as soon as its last session closed would hand the
   * user a fresh rate limiter on reconnect; the full-bucket check additionally
   * keeps an entry whose limiter is still refilling (e.g. a request that was
   * in flight when its session closed), so evicting never grants capacity.
   * Lazy (run on acquire): entries only accumulate as new sessions arrive.
   */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.liveSessions > 0 || now - entry.lastUsedAt < this.idleEvictionMs) continue;
      const status = entry.components.rateLimiter.getStatus();
      if (status.available < status.limit) continue;
      this.entries.delete(key);
    }
  }

  private evictLeastRecentlyUsedIdle(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.liveSessions === 0 && entry.lastUsedAt < oldestAt) {
        oldestKey = key;
        oldestAt = entry.lastUsedAt;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
