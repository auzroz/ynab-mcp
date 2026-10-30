/**
 * Rate Limiter
 * 
 * Token bucket algorithm to enforce YNAB's API rate limits.
 * YNAB allows 200 requests/hour; we default to 180 for safety margin.
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

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private acquireLock: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  // Send times (ms) of requests in the last hour, oldest first. Lets a 429 from
  // YNAB be mapped to "when the oldest request leaves YNAB's rolling window".
  private sentAt: number[] = [];
  private ynabExhaustedAt: number | undefined;
  private ynabExhaustedUntil = 0;

  // `now` is injectable so callers that reason about refill time (the HTTP
  // user registry's eviction check) can be tested on a fake clock.
  constructor(requestsPerHour: number = 180, now: () => number = Date.now) {
    // Validate requestsPerHour to prevent rate-limit bypass
    if (!Number.isFinite(requestsPerHour) || requestsPerHour <= 0) {
      throw new Error(`Invalid requestsPerHour: must be a positive finite number, got ${requestsPerHour}`);
    }
    this.maxTokens = requestsPerHour;
    this.now = now;
    this.tokens = requestsPerHour;
    this.lastRefill = now();
    // Convert requests/hour to requests/millisecond
    this.refillRate = requestsPerHour / (60 * 60 * 1000);
  }

  /**
   * Acquire a token, waiting if necessary.
   * Call this before making any API request.
   * Uses a mutex to prevent race conditions with concurrent callers.
   */
  async acquire(): Promise<void> {
    // Chain onto the existing lock to ensure sequential execution
    const previousLock = this.acquireLock;
    let releaseLock: () => void;
    this.acquireLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      // Wait for previous acquire to complete
      await previousLock;

      // YNAB said 429: fail fast instead of queueing a request known to fail.
      this.throwIfExhaustedByYnab();

      this.refill();

      if (this.tokens < 1) {
        // Calculate wait time to get at least 1 token
        const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
        await this.sleep(waitTime);
        this.refill();
      }

      // The wait above can span a 429 noted by another request.
      this.throwIfExhaustedByYnab();

      this.tokens -= 1;
      this.recordSent();
    } finally {
      releaseLock!();
    }
  }

  /**
   * Give back a token taken by acquire() for a request that was never sent
   * (e.g. its access token could not be resolved). Capped at the bucket size.
   */
  release(): void {
    this.sentAt.pop();
    this.refill();
    this.tokens = Math.min(this.maxTokens, this.tokens + 1);
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

    return {
      available,
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

  private throwIfExhaustedByYnab(): void {
    const remaining = this.ynabExhaustedUntil - this.now();
    if (remaining > 0) throw new RateLimitError(remaining);
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
