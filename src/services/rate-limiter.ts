/**
 * Rate Limiter
 * 
 * Token bucket algorithm to enforce YNAB's API rate limits.
 * YNAB allows 200 requests/hour; we default to 180 for safety margin.
 *
 * acquire() fails fast: when the bucket is empty it waits at most maxWaitMs
 * (RATE_LIMIT_MAX_WAIT_MS, default 2 s, 0 = never wait) and only one caller may
 * wait at a time; everyone else gets a RateLimitError carrying the retry time.
 *
 * It also tracks the sent requests of the last hour and, when YNAB itself
 * answers 429, can be marked exhausted until YNAB's window would reset so the
 * server stops sending requests it knows will fail (see markExhaustedByYnab).
 */

import { RateLimitError } from '../utils/errors.js';

const HOUR_MS = 60 * 60 * 1000;
/** Shortest and longest exhaustion window honoured, whatever YNAB's header says. */
const MIN_EXHAUSTION_MS = 1000;
const MAX_EXHAUSTION_MS = HOUR_MS;
/** Used when YNAB gives no Retry-After and no request is recorded to expire. */
const DEFAULT_EXHAUSTION_MS = 60 * 1000;
/** Default for how long acquire() may wait for a token before failing. */
export const DEFAULT_MAX_WAIT_MS = 2000;
/** Cap on remembered rejections so a flood cannot grow memory. */
const MAX_TRACKED_REJECTIONS = 1000;

/**
 * What YnabClient needs from a request limiter. Async where a shared store (a
 * Postgres-backed limiter for several instances, #67b) would have to be, so the
 * token bucket can be swapped without touching callers; the in-process
 * RateLimiter below is the one implementation today.
 */
export interface RequestLimiter {
  /** Take one request's token, or throw a RateLimitError (fail fast). */
  acquire(): Promise<void>;
  /** Take `count` tokens all at once or throw a RateLimitError; returns the number taken. */
  acquireMany(count: number): Promise<number>;
  /** Give back tokens for requests that were never sent. */
  release(count?: number): void;
  /** Note YNAB's own 429; returns the exhaustion window in ms. */
  markExhaustedByYnab(retryAfter?: number | string | null): number;
  /** Throw a RateLimitError while YNAB's own 429 window is in force. */
  throwIfExhaustedByYnab(): void;
  getStatus(): ReturnType<RateLimiter['getStatus']>;
}

/** A 429 from YNAB, as the limiter remembers it. */
export interface YnabExhaustion {
  /** True while requests are being refused locally because of the 429. */
  active: boolean;
  /** Epoch ms of the most recent 429. */
  exhaustedAtMs: number;
  /** Epoch ms when requests are allowed again. */
  untilMs: number;
  /** Milliseconds left until untilMs (0 once it has passed). */
  retryAfterMs: number;
}

export class RateLimiter implements RequestLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private readonly maxWaitMs: number;
  /** True while one caller sleeps for a token; a second caller fails fast. */
  private waiterActive = false;
  private rejectedAt: number[] = [];
  private readonly now: () => number;
  // Send times (ms) of requests in the last hour, oldest first. Lets a 429 from
  // YNAB be mapped to "when the oldest request leaves YNAB's rolling window".
  private sentAt: number[] = [];
  private ynabExhaustedAt: number | undefined;
  private ynabExhaustedUntil = 0;

  // `now` is injectable so callers that reason about refill time (the HTTP
  // user registry's eviction check) can be tested on a fake clock.
  constructor(
    requestsPerHour: number = 180,
    now: () => number = Date.now,
    maxWaitMs: number = DEFAULT_MAX_WAIT_MS
  ) {
    // Validate requestsPerHour to prevent rate-limit bypass
    if (!Number.isFinite(requestsPerHour) || requestsPerHour <= 0) {
      throw new Error(`Invalid requestsPerHour: must be a positive finite number, got ${requestsPerHour}`);
    }
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
      throw new Error(`Invalid maxWaitMs: must be a finite number >= 0, got ${maxWaitMs}`);
    }
    this.maxWaitMs = maxWaitMs;
    this.maxTokens = requestsPerHour;
    this.now = now;
    this.tokens = requestsPerHour;
    this.lastRefill = now();
    // Convert requests/hour to requests/millisecond
    this.refillRate = requestsPerHour / (60 * 60 * 1000);
  }

  /**
   * Acquire a token. Fails fast: with a token available it returns at once; if
   * one arrives within maxWaitMs and nobody else is waiting, it waits for it;
   * otherwise it throws a RateLimitError with the time until a token is free.
   * At most one caller waits at a time, so a burst cannot queue up.
   * Call this before making any API request.
   */
  async acquire(): Promise<void> {
    // YNAB said 429: fail fast instead of queueing a request known to fail.
    this.throwIfExhaustedByYnab();
    this.refill();

    if (this.tokens < 1 || this.waiterActive) {
      // A waiting caller will take the next token, so a second caller needs the one after it.
      const needed = this.waiterActive ? 2 - this.tokens : 1 - this.tokens;
      const waitMs = Math.ceil(needed / this.refillRate);
      if (this.waiterActive || this.maxWaitMs === 0 || waitMs > this.maxWaitMs) {
        throw this.reject(waitMs);
      }
      this.waiterActive = true;
      try {
        await this.sleep(waitMs);
      } finally {
        this.waiterActive = false;
      }
      // The wait can span a 429 noted by another request.
      this.throwIfExhaustedByYnab();
      this.refill();
      // Tolerate float rounding / an early timer: the wait covered the shortfall.
      if (this.tokens < 1 - 1e-6) {
        // A release/refill race took the token: report the time to the next one.
        throw this.reject(Math.ceil((1 - this.tokens) / this.refillRate));
      }
    }

    this.tokens = Math.max(0, this.tokens - 1);
    this.recordSent();
  }

  /**
   * Take `count` tokens at once or none: a fan-out reservation (#58). Never
   * waits; when the bucket holds fewer than `count` it throws a RateLimitError
   * carrying the time until `count` tokens are free, so a multi-request tool
   * refuses up front instead of failing after some of its calls were sent. Give
   * back what goes unused with release(n). Returns the number taken. A
   * `count` beyond the bucket size can never be satisfied, so it is refused
   * (with the time until the bucket is full, the best case) instead of being
   * cut down to what a part-way failure would leave.
   */
  async acquireMany(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid token count: must be a positive integer, got ${count}`);
    }
    this.throwIfExhaustedByYnab();
    this.refill();
    const needed = count;
    // A caller already waiting for a token has the next one; this reservation must not jump it.
    const required = Math.min(needed, this.maxTokens) + (this.waiterActive ? 1 : 0);
    // Tolerate float rounding, as acquire() does.
    if (this.tokens < required - 1e-6 || needed > this.maxTokens) {
      throw this.reject(Math.ceil((required - this.tokens) / this.refillRate));
    }
    this.tokens = Math.max(0, this.tokens - needed);
    for (let i = 0; i < needed; i++) this.recordSent();
    return needed;
  }

  /**
   * Give back tokens taken by acquire() or acquireMany() for requests that were
   * never sent (e.g. an access token that could not be resolved, a fan-out's
   * unused share). Capped at the bucket size.
   */
  release(count = 1): void {
    for (let i = 0; i < count; i++) this.sentAt.pop();
    this.refill();
    this.tokens = Math.min(this.maxTokens, this.tokens + count);
  }

  /**
   * Check if a request can be made immediately.
   */
  canAcquire(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  /**
   * Get current number of available tokens.
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Get estimated time until a token is available (in ms).
   */
  getWaitTime(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  /**
   * Get comprehensive rate limit status.
   */
  getStatus(): {
    available: number;
    limit: number;
    used: number;
    percentUsed: number;
    canMakeRequest: boolean;
    waitTimeMs: number;
    resetTimeMs: number;
    /** Requests sent in the last hour (this limiter's own record, not YNAB's). */
    sentLastHour: number;
    /** Calls refused by acquire() in the last hour (capped). */
    rejectedLastHour: number;
    /** How long acquire() may wait for a token before failing (ms). */
    maxWaitMs: number;
    /** Set once YNAB has answered 429 to this limiter's requests; absent before that. */
    ynabExhausted?: YnabExhaustion;
  } {
    this.refill();
    const ynabExhausted = this.getYnabExhaustion();
    const exhaustedMs = ynabExhausted?.retryAfterMs ?? 0;
    const available = Math.floor(this.tokens);
    const used = this.maxTokens - available;
    const percentUsed = Math.round((used / this.maxTokens) * 100);
    // Inline wait time calculation to avoid redundant refill() call in getWaitTime()
    const bucketWaitMs = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillRate);
    const waitTimeMs = Math.max(bucketWaitMs, exhaustedMs);
    // Time until fully refilled
    const tokensNeeded = this.maxTokens - this.tokens;
    const resetTimeMs = tokensNeeded > 0 ? Math.ceil(tokensNeeded / this.refillRate) : 0;

    const nowMs = this.now();
    this.pruneSent(nowMs);
    this.pruneRejected(nowMs);

    return {
      available,
      sentLastHour: this.sentAt.length,
      rejectedLastHour: this.rejectedAt.length,
      maxWaitMs: this.maxWaitMs,
      limit: this.maxTokens,
      used,
      percentUsed,
      canMakeRequest: available >= 1 && exhaustedMs === 0,
      waitTimeMs,
      resetTimeMs: Math.max(resetTimeMs, exhaustedMs),
      ...(ynabExhausted ? { ynabExhausted } : {}),
    };
  }

  /**
   * Record that YNAB answered 429. Until YNAB's window would reset, acquire()
   * rejects with a RateLimitError instead of letting requests through. The
   * window is retryAfterMs when YNAB sent a usable Retry-After, else the time
   * until the oldest request in the rolling hour expires, else a safe default;
   * it is clamped to 1 second .. 1 hour.
   */
  markExhaustedByYnab(retryAfter?: number | string | null): number {
    const now = this.now();
    this.pruneSent(now);
    // A string is a raw Retry-After header value; a number is milliseconds.
    const retryAfterMs =
      typeof retryAfter === 'string' ? parseRetryAfterMs(retryAfter, now) : retryAfter ?? undefined;
    let windowMs: number;
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      windowMs = retryAfterMs;
    } else if (this.sentAt.length > 0) {
      windowMs = this.sentAt[0]! + HOUR_MS - now;
    } else {
      windowMs = DEFAULT_EXHAUSTION_MS;
    }
    windowMs = Math.min(MAX_EXHAUSTION_MS, Math.max(MIN_EXHAUSTION_MS, Math.ceil(windowMs)));
    // Never shorten a window already in force.
    this.ynabExhaustedUntil = Math.max(this.ynabExhaustedUntil, now + windowMs);
    this.ynabExhaustedAt = now;
    return this.ynabExhaustedUntil - now;
  }

  /** The most recent 429 from YNAB, or undefined if there has not been one. */
  getYnabExhaustion(): YnabExhaustion | undefined {
    if (this.ynabExhaustedAt === undefined) return undefined;
    const retryAfterMs = Math.max(0, this.ynabExhaustedUntil - this.now());
    return {
      active: retryAfterMs > 0,
      exhaustedAtMs: this.ynabExhaustedAt,
      untilMs: this.ynabExhaustedUntil,
      retryAfterMs,
    };
  }

  /** Throw a RateLimitError while YNAB's own 429 window is in force. */
  throwIfExhaustedByYnab(): void {
    const remaining = this.ynabExhaustedUntil - this.now();
    if (remaining > 0) throw this.reject(remaining);
  }

  private reject(waitMs: number): RateLimitError {
    const now = this.now();
    this.pruneRejected(now);
    if (this.rejectedAt.length < MAX_TRACKED_REJECTIONS) this.rejectedAt.push(now);
    return new RateLimitError(Math.max(1, waitMs));
  }

  private pruneRejected(now: number): void {
    const cutoff = now - HOUR_MS;
    let i = 0;
    while (i < this.rejectedAt.length && this.rejectedAt[i]! <= cutoff) i++;
    if (i > 0) this.rejectedAt.splice(0, i);
  }

  private recordSent(): void {
    const now = this.now();
    this.pruneSent(now);
    this.sentAt.push(now);
  }

  private pruneSent(now: number): void {
    const cutoff = now - HOUR_MS;
    let i = 0;
    while (i < this.sentAt.length && this.sentAt[i]! <= cutoff) i++;
    if (i > 0) this.sentAt.splice(0, i);
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Parse a Retry-After header (delta-seconds or an HTTP date) into milliseconds
 * from `nowMs`. Returns undefined when absent or unusable; 0 when the header
 * says to retry immediately ("0" or a date in the past).
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  const ms = date - nowMs;
  // A date already in the past means "retry now": 0, not "no header".
  return Math.max(0, ms);
}
