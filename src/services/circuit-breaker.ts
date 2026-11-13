/**
 * Circuit breaker for one user's YNAB traffic (#58).
 *
 * After `threshold` consecutive failures (5xx responses or timeouts) with the
 * first of them less than `windowMs` old, the breaker opens and every request
 * fails fast with a CircuitOpenError for `openMs`, so a YNAB outage is not
 * answered with a full timeout per request (each of which would hold an
 * in-flight slot, ADR-0001 D5). When that time is over it half-opens: one
 * probe request is let through. A probe that succeeds closes the breaker, one
 * that fails opens it again for another `openMs`. A response below 500, even a
 * 4xx or 429, shows YNAB is answering and resets the streak.
 *
 * Per user, so one user's bad token or outage never trips another's requests;
 * it lives in the user's components next to the rate limiter.
 */

import { CircuitOpenError } from '../utils/errors.js';

export const BREAKER_FAILURE_THRESHOLD = 20;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_OPEN_MS = 30_000;
/** What a request refused during a half-open probe is told to wait. */
const PROBE_RETRY_MS = 1000;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  threshold?: number;
  windowMs?: number;
  openMs?: number;
  now?: () => number;
}

/** One admitted request; settle it exactly once (later calls do nothing). */
export interface CircuitAttempt {
  /** YNAB answered with something other than a 5xx. */
  success(): void;
  /** A 5xx or a timeout. */
  failure(): void;
  /** The request ended without telling anything about YNAB (caller abort, our own deadline). */
  cancel(): void;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private failures = 0;
  private firstFailureAt = 0;
  /** 0 while closed; otherwise when the open period ends (half-open afterwards). */
  private openUntil = 0;
  private probing = false;
  private trips = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? BREAKER_FAILURE_THRESHOLD;
    this.windowMs = opts.windowMs ?? BREAKER_WINDOW_MS;
    this.openMs = opts.openMs ?? BREAKER_OPEN_MS;
    this.now = opts.now ?? Date.now;
    for (const [name, v] of Object.entries({ threshold: this.threshold, windowMs: this.windowMs, openMs: this.openMs })) {
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid circuit breaker ${name}: ${v}`);
    }
  }

  /** Let a request through, or throw CircuitOpenError. */
  admit(): CircuitAttempt {
    const now = this.now();
    let probe = false;
    if (this.openUntil !== 0) {
      if (now < this.openUntil) throw new CircuitOpenError(this.openUntil - now);
      if (this.probing) throw new CircuitOpenError(PROBE_RETRY_MS);
      this.probing = true;
      probe = true;
    }
    let settled = false;
    const settle = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      apply();
    };
    return {
      success: () => settle(() => this.onSuccess(probe)),
      failure: () => settle(() => this.onFailure(probe)),
      cancel: () =>
        settle(() => {
          if (probe) this.probing = false;
        }),
    };
  }

  state(): BreakerState {
    if (this.openUntil === 0) return 'closed';
    return this.now() < this.openUntil ? 'open' : 'half_open';
  }

  status(): { state: BreakerState; consecutiveFailures: number; retryAfterMs: number; trips: number } {
    const now = this.now();
    return {
      state: this.state(),
      consecutiveFailures: this.failures,
      retryAfterMs: this.openUntil > now ? this.openUntil - now : 0,
      trips: this.trips,
    };
  }

  private onSuccess(probe: boolean): void {
    // A request admitted before the breaker opened says nothing about now.
    if (this.openUntil !== 0 && !probe) return;
    this.failures = 0;
    this.firstFailureAt = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  private onFailure(probe: boolean): void {
    const now = this.now();
    if (probe) {
      this.probing = false;
      this.open(now);
      return;
    }
    if (this.openUntil !== 0) return;
    // A streak whose first failure is older than the window starts over.
    if (this.failures > 0 && now - this.firstFailureAt > this.windowMs) this.failures = 0;
    if (this.failures === 0) this.firstFailureAt = now;
    this.failures++;
    if (this.failures >= this.threshold) this.open(now);
  }

  private open(now: number): void {
    this.openUntil = now + this.openMs;
    this.trips++;
  }
}
