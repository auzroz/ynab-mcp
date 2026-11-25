/**
 * The per-user YNAB request limiter shared by every replica on one Postgres
 * database (#67c, `RATE_LIMIT_STORE=postgres`). Same interface and the same
 * rules as the in-process RateLimiter (#58), so YnabClient doesn't know which
 * one it has:
 *
 *  - acquire() fails fast with a RateLimitError carrying the time until a
 *    token is free. It waits at most RATE_LIMIT_MAX_WAIT_MS, and only one
 *    caller per user waits at a time, now across every replica: the waiter's
 *    token is booked in the database, so another caller is told the time after
 *    it.
 *  - acquireMany(n) takes all n tokens of a fan-out in one statement, or none
 *    (with the time until they are free); n above the bucket size is refused.
 *  - release(n) gives tokens back for requests that were never sent.
 *  - A YNAB 429 is shared too (`blocked_until`), so no replica keeps sending
 *    into YNAB's window; this replica also refuses at once, as before. A
 *    caller that waited for a booked token reads the shared pause again
 *    before sending, and refuses (giving the token back) if one began.
 *
 * The budget lives in `rate_limit_buckets` (src/storage/shared-limits.ts), one
 * row per user, changed by one statement per call on the database's clock.
 *
 * When the database can't answer within the limiter pool's bounds, acquire()
 * and acquireMany() throw RateLimitStoreUnavailableError (a tool call's
 * `upstream_unavailable` with retry_after_seconds): fail closed, never a
 * fall back to a budget of this process's own. release() and the 429 note are
 * sent without waiting; one that fails is logged by the store and lost, which
 * can only leave the user with fewer tokens, never more.
 *
 * getStatus() stays synchronous: it reads the bucket as the last statement
 * left it (refilled locally since). refresh() reads it again.
 */

import { RateLimitError, RateLimitStoreUnavailableError } from '../utils/errors.js';
import { DEFAULT_MAX_WAIT_MS, HOUR_MS, RateLimiter } from './rate-limiter.js';
import {
  SHARED_LIMIT_RETRY_AFTER_MS,
  type BucketShape,
  type BucketState,
  type SharedLimitStore,
} from '../storage/shared-limits.js';

export class SharedRateLimiter extends RateLimiter {
  protected override readonly storeKind = 'postgres' as const;
  private readonly shape: BucketShape;
  private readonly capacity: number;

  constructor(
    private readonly store: SharedLimitStore,
    private readonly userId: string,
    requestsPerHour: number = 180,
    now: () => number = Date.now,
    maxWaitMs: number = DEFAULT_MAX_WAIT_MS
  ) {
    super(requestsPerHour, now, maxWaitMs);
    // Whole tokens; each costs a whole number of milliseconds, rounded up so
    // the shared budget is never above RATE_LIMIT_PER_HOUR.
    this.capacity = Math.max(1, Math.floor(requestsPerHour));
    const intervalMs = Math.ceil(HOUR_MS / requestsPerHour);
    this.shape = { intervalMs, burstMs: intervalMs * this.capacity };
  }

  override async acquire(): Promise<void> {
    this.throwIfExhaustedByYnab();
    const state = await this.shared(() => this.store.take(this.userId, 1, this.shape, this.maxWaitMs));
    this.observe(state);
    if (state.tat === state.previousTat) throw this.reject(this.refusalWaitMs(state, 1));
    // Booked ahead of the bucket: this caller is the user's one waiter.
    const waitMs = state.tat - state.now - this.shape.burstMs;
    if (waitMs > 0) {
      await this.sleep(waitMs);
      try {
        // The wait can span a 429 noted by another request, here or on
        // another replica: read the shared pause again before sending.
        this.throwIfExhaustedByYnab();
        this.observe(await this.shared(() => this.store.peek(this.userId)));
        this.throwIfExhaustedByYnab();
      } catch (error) {
        // Not sent: the booked token goes back, and the caller gets the
        // pause's retry time (or the store's, when it can't be read).
        this.giveBack(1);
        throw error;
      }
    }
    this.recordSent();
  }

  override async acquireMany(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid token count: must be a positive integer, got ${count}`);
    }
    this.throwIfExhaustedByYnab();
    // Never booked ahead: a reservation is all of it now or a refusal.
    const state = await this.shared(() => this.store.take(this.userId, count, this.shape, 0));
    this.observe(state);
    if (state.tat === state.previousTat) throw this.reject(this.refusalWaitMs(state, count));
    for (let i = 0; i < count; i++) this.recordSent();
    return count;
  }

  override release(count = 1): void {
    for (let i = 0; i < count; i++) this.sentAt.pop();
    this.giveBack(count);
  }

  override markExhaustedByYnab(retryAfter?: number | string | null): number {
    const windowMs = super.markExhaustedByYnab(retryAfter);
    this.store.block(this.userId, windowMs).catch(() => undefined);
    return windowMs;
  }

  /** Read the shared bucket again, for getStatus(). Throws RateLimitStoreUnavailableError when it can't. */
  async refresh(): Promise<void> {
    this.observe(await this.shared(() => this.store.peek(this.userId)));
  }

  /** Tokens back to the shared bucket (and the snapshot), without waiting. */
  private giveBack(count: number): void {
    this.refill();
    this.tokens = Math.min(this.maxTokens, this.tokens + count);
    this.store.give(this.userId, count, this.shape).catch(() => undefined);
  }

  /**
   * How long a refused take must wait: YNAB's 429 window, or the time until
   * `count` tokens (at most the bucket's size, the best a too-large request
   * could hope for) are free after whatever is booked.
   */
  private refusalWaitMs(state: BucketState, count: number): number {
    const blockedMs = state.blockedUntil - state.now;
    const tokensMs =
      Math.max(state.previousTat, state.now) + Math.min(count, this.capacity) * this.shape.intervalMs - state.now - this.shape.burstMs;
    return Math.max(1, blockedMs, tokensMs);
  }

  /** Keep the bucket as the database left it, for getStatus(), and its 429 window locally too. */
  private observe(state: BucketState): void {
    const owedMs = Math.max(0, state.tat - state.now);
    this.tokens = Math.max(0, (this.shape.burstMs - owedMs) / this.shape.intervalMs);
    const localNow = this.now();
    this.lastRefill = localNow;
    const blockedMs = state.blockedUntil - state.now;
    if (blockedMs > 0) {
      this.ynabExhaustedUntil = Math.max(this.ynabExhaustedUntil, localNow + blockedMs);
      this.ynabExhaustedAt ??= localNow;
    }
  }

  /** Run a store call; any failure is a refusal, never a local budget. */
  private async shared<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      throw new RateLimitStoreUnavailableError(SHARED_LIMIT_RETRY_AFTER_MS);
    }
  }
}
