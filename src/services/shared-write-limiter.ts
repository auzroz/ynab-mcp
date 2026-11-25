/**
 * The per-user write cap (#61c, YNAB_WRITE_LIMIT_PER_HOUR) shared by every
 * replica on one Postgres database (`RATE_LIMIT_STORE=postgres`, #67). With
 * per-process caps, N replicas would allow N times the cap, which defeats its
 * point: bounding what a prompt-injected or runaway client can rewrite.
 *
 * Same rules as the in-process WriteLimiter: a sliding window of one hour (at
 * most `limit` writes in any 60 minutes; the next is allowed when the oldest
 * counted one is an hour old), a bulk call counts as one, a limit of 0 turns
 * the cap off, a write that fails input validation gives its slot back, and
 * the first refusal of an episode is flagged for the audit log (#60a), now
 * once per user across replicas. The admissions live in `rate_limit_writes`
 * (src/storage/shared-limits.ts), one row per user, changed by one statement
 * under the row's lock on the database's clock.
 *
 * Fails closed: when the database can't answer within the limiter pool's
 * bounds, tryAcquire() throws RateLimitStoreUnavailableError, before the
 * tool's handler and so before any YNAB request.
 */

import { RateLimitStoreUnavailableError } from '../utils/errors.js';
import { SHARED_LIMIT_RETRY_AFTER_MS, SHARED_WRITE_WINDOW_MS, type SharedLimitStore } from '../storage/shared-limits.js';
import type { WriteAdmission, WriteCap } from './write-limiter.js';

export class SharedWriteLimiter implements WriteCap {
  constructor(
    private readonly store: SharedLimitStore,
    private readonly userId: string,
    private readonly limit: number
  ) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('Write limit must be a non-negative integer.');
    }
  }

  get limitPerHour(): number {
    return this.limit;
  }

  async tryAcquire(): Promise<WriteAdmission> {
    if (this.limit === 0) return { allowed: true, release: () => undefined };
    let state;
    try {
      state = await this.store.admitWrite(this.userId, this.limit, SHARED_WRITE_WINDOW_MS);
    } catch {
      // Logged by the store. Never a cap of this process's own.
      throw new RateLimitStoreUnavailableError(SHARED_LIMIT_RETRY_AFTER_MS);
    }
    if (!state.allowed) {
      return {
        allowed: false,
        limit: this.limit,
        // The database's clock; resetsAt is reported as an absolute time.
        resetsAt: state.resetsAt,
        retryAfterMs: Math.max(1, state.resetsAt - state.now),
        firstRefusal: state.firstRefusal,
      };
    }
    const admittedAt = state.now;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        // Without waiting: a lost release only leaves the user one slot short for the hour.
        this.store.releaseWrite(this.userId, admittedAt).catch(() => undefined);
      },
    };
  }
}
