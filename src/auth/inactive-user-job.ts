/**
 * The inactive-user erase (#54e, D-5): a background job, off by default.
 *
 * With `MCP_INACTIVE_USER_DAYS` set (30 to 3650), each pass erases every user
 * who has not been seen for that many days and has no live grant, using
 * `deleteUserData` with its inactive-user condition:
 *
 *   - "Seen" is `users.last_seen_at`: stamped by a sign-in or re-consent and
 *     by every YNAB refresh (about every two hours while the user makes
 *     requests). Users from before the upgrade start at the upgrade (the
 *     schema 6 backfill), never at older activity; a row without one (written
 *     by a 0.4.x replica since the last startup) is never erased.
 *   - "No live grant" is the rule in src/storage/user-data.ts: no unexpired,
 *     unconsumed MCP token, code or sign-in in flight, in either generation.
 *   - Both are re-checked inside the erase's transaction (on Postgres under
 *     the account and family locks, with the user row locked), so a sign-in,
 *     refresh or token mint racing the erase either lands first and keeps the
 *     user, or runs after and finds the account gone.
 *
 * The listing only proposes candidates. The log gives counts only, never a
 * user id. Two replicas running passes at once is safe: each erase is
 * re-checked, so the second finds the user gone and counts nothing.
 */

import type { Storage } from '../storage/types.js';
import type { JobExtension, JobHandle } from '../http/extensions.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';
import { logInfo } from '../utils/log.js';

const DAY_MS = 24 * 3_600_000;

/** Time between passes. */
export const INACTIVE_USER_INTERVAL_MS = 60 * 60_000;
/** Delay before the first pass after startup. */
export const INACTIVE_USER_FIRST_PASS_MS = 60_000;
/** Candidates per page. */
export const INACTIVE_USER_PAGE_SIZE = 100;

export interface InactiveUserPassOptions {
  now?: () => number;
  pageSize?: number;
  log?: (message: string) => void;
}

/** What one pass did. Counts only. */
export interface InactiveUserPassResult {
  /** Users erased. */
  erased: number;
  /** Erases that failed (a storage error); the next pass tries again. */
  failed: number;
}

/** One pass: erase the users not seen for `days` days and with no live grant. */
export async function eraseInactiveUsers(
  storage: Storage,
  days: number,
  options: InactiveUserPassOptions = {}
): Promise<InactiveUserPassResult> {
  const now = (options.now ?? Date.now)();
  const pageSize = options.pageSize ?? INACTIVE_USER_PAGE_SIZE;
  const log = options.log ?? ((m: string) => console.error(m));
  const condition = { seenBefore: now - days * DAY_MS, now };
  const result: InactiveUserPassResult = { erased: 0, failed: 0 };

  let after: string | undefined;
  for (;;) {
    const page = await storage.listInactiveUsers(condition.seenBefore, after, pageSize);
    for (const userId of page) {
      try {
        if (await storage.deleteUserData(userId, condition)) result.erased++;
      } catch {
        result.failed++;
      }
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1];
  }

  if (result.erased > 0 || result.failed > 0) {
    log(
      `[InactiveUsers] erased ${result.erased} user(s) not seen for ${days} days and with no live grant` +
        (result.failed > 0 ? `; ${result.failed} could not be erased (the next pass tries again)` : '')
    );
  }
  return result;
}

export interface InactiveUserJobOptions extends InactiveUserPassOptions {
  firstPassMs?: number;
  intervalMs?: number;
}

/** Start the job: a first pass soon after startup, then one per interval. Timers are unref()'d. */
export function startInactiveUserJob(storage: Storage, days: number, options: InactiveUserJobOptions = {}): JobHandle {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref();
  };
  function tick(): void {
    running = eraseInactiveUsers(storage, days, options)
      .then(
        () => undefined,
        (error: unknown) => {
          console.error('[InactiveUsers] pass failed:', sanitizeErrorMessage(error));
        }
      )
      .finally(() => {
        running = undefined;
        schedule(options.intervalMs ?? INACTIVE_USER_INTERVAL_MS);
      });
  }
  schedule(options.firstPassMs ?? INACTIVE_USER_FIRST_PASS_MS);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}

/** The job extension (src/http/extensions.ts): runs only with storage and `MCP_INACTIVE_USER_DAYS` set. */
export const inactiveUserJob: JobExtension = {
  name: 'inactive-users',
  start(ctx) {
    const days = ctx.config.inactiveUserDays;
    if (!ctx.storage || days === undefined) return undefined;
    logInfo(`[InactiveUsers] erasing users not seen for ${days} days and with no live grant`);
    return startInactiveUserJob(ctx.storage, days);
  },
};
