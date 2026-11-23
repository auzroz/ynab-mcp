/**
 * Per-user write cap (#61c, D-8).
 *
 * Bounds how many write requests one user can make per hour, so a prompt
 * injection or a runaway agent cannot rewrite a budget in a loop. A write
 * request is one write tool call: a bulk call counts as 1. It is separate from
 * the YNAB request limiter (RateLimiter), which counts YNAB requests, and is
 * checked before it, so a refused write costs no YNAB request.
 *
 * A sliding window: the cap allows `limit` admissions in any 60 minutes. When
 * it is used up, the next write is allowed once the oldest counted one is an
 * hour old (`resetsAt`). A limit of 0 disables the cap.
 */

export const WRITE_WINDOW_MS = 60 * 60 * 1000;

export type WriteAdmission =
  | {
      allowed: true;
      /** Give the slot back (idempotent). For a call that failed input validation before any YNAB request. */
      release: () => void;
    }
  | {
      allowed: false;
      limit: number;
      /** Epoch ms at which a slot frees up. */
      resetsAt: number;
      retryAfterMs: number;
      /** True for the first refusal since the last admitted write, so callers can audit an episode once. */
      firstRefusal: boolean;
    };

export class WriteLimiter {
  /** Admission times, oldest first; at most `limit` of them. */
  private readonly admitted: number[] = [];
  private refusedSinceAdmit = false;

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('Write limit must be a non-negative integer.');
    }
  }

  get limitPerHour(): number {
    return this.limit;
  }

  /** Count one write request if the cap allows it. */
  tryAcquire(): WriteAdmission {
    if (this.limit === 0) return { allowed: true, release: () => undefined };
    const now = this.now();
    while (this.admitted.length > 0 && now - (this.admitted[0] as number) >= WRITE_WINDOW_MS) {
      this.admitted.shift();
    }
    if (this.admitted.length < this.limit) {
      this.admitted.push(now);
      this.refusedSinceAdmit = false;
      let released = false;
      return {
        allowed: true,
        release: () => {
          if (released) return;
          released = true;
          const i = this.admitted.indexOf(now);
          if (i !== -1) this.admitted.splice(i, 1);
        },
      };
    }
    const resetsAt = (this.admitted[0] as number) + WRITE_WINDOW_MS;
    const firstRefusal = !this.refusedSinceAdmit;
    this.refusedSinceAdmit = true;
    return { allowed: false, limit: this.limit, resetsAt, retryAfterMs: Math.max(1, resetsAt - now), firstRefusal };
  }

  /** Writes counted in the current window (for status and tests). */
  used(): number {
    const now = this.now();
    return this.admitted.filter((t) => now - t < WRITE_WINDOW_MS).length;
  }
}
