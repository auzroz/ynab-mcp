/**
 * The retention sweep (#54b): a background job that deletes what has outlived
 * its retention window, every {@link SWEEP_INTERVAL_MS}. Always on when the
 * server has storage (oauth mode); the windows are settings
 * (src/config/http/retention.ts) that the storage driver was built with.
 *
 * The first {@link SweepStep} is `Storage.sweepExpired`: expired codes,
 * tokens and sign-ins, consumed credentials past their replay window,
 * orphaned tokens, expired grants, and abandoned or unused client
 * registrations, in batches (on Postgres under an advisory lock, so replicas
 * don't sweep at once; a replica that finds the lock held does nothing).
 * The second is `Storage.sweepRateLimitRows` (#67): ended rate-limit windows
 * and full, idle request buckets of the shared limiters (no lock: its
 * batches skip rows a limiter holds, and deleting a row twice is harmless).
 *
 * Seam for #60b: the audit-log prune (90 days) is a further entry in
 * {@link SWEEP_STEPS}, with no change to the scheduling below.
 *
 * Failure handling: a step that throws is logged (through
 * `sanitizeErrorMessage`) and the remaining steps still run; a failed pass
 * never stops the schedule. The log gives counts only, never a row key, user
 * or client id.
 */

import type { Storage } from '../storage/types.js';
import type { JobExtension, JobHandle } from '../http/extensions.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

/** Time between passes. */
export const SWEEP_INTERVAL_MS = 15 * 60_000;
/** Delay before the first pass after startup. */
export const SWEEP_FIRST_PASS_MS = 30_000;

/** One kind of deletion in a pass. Returns its counts, by a fixed name each. */
export interface SweepStep {
  /** Short label for the log. */
  readonly name: string;
  run(storage: Storage): Promise<Readonly<Record<string, number>>>;
}

/** The steps of a pass, in order. #60b appends the audit-log prune here. */
export const SWEEP_STEPS: readonly SweepStep[] = [
  {
    name: 'expired-rows',
    async run(storage) {
      const { ran, deleted } = await storage.sweepExpired();
      // Another replica holds the sweep lock: it is doing this work.
      return ran ? { ...deleted } : {};
    },
  },
  {
    // #67: shared limiter rows that limit nothing any more (RATE_LIMIT_STORE=postgres).
    name: 'rate-limit-rows',
    async run(storage) {
      return { ...(await storage.sweepRateLimitRows()) };
    },
  },
];

export interface SweepPassOptions {
  steps?: readonly SweepStep[];
  log?: (message: string) => void;
}

/** What one pass did. */
export interface SweepPassResult {
  /** Rows deleted, summed over every step's counts. */
  deleted: number;
  /** Steps that threw; the next pass tries again. */
  failed: number;
}

/** One pass over every step. Never throws. */
export async function runSweepPass(storage: Storage, options: SweepPassOptions = {}): Promise<SweepPassResult> {
  const steps = options.steps ?? SWEEP_STEPS;
  const log = options.log ?? ((m: string) => console.error(m));
  const result: SweepPassResult = { deleted: 0, failed: 0 };

  for (const step of steps) {
    try {
      const counts = await step.run(storage);
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${key}=${n}`);
      if (parts.length > 0) {
        result.deleted += Object.values(counts).reduce((a, b) => a + b, 0);
        log(`[Sweep] ${step.name}: deleted ${parts.join(' ')}`);
      }
    } catch (error) {
      result.failed++;
      log(`[Sweep] ${step.name} failed (the next pass tries again): ${sanitizeErrorMessage(error)}`);
    }
  }
  return result;
}

export interface SweepJobOptions extends SweepPassOptions {
  firstPassMs?: number;
  intervalMs?: number;
}

/** Start the job: a first pass soon after startup, then one per interval. Timers are unref()'d. */
export function startSweepJob(storage: Storage, options: SweepJobOptions = {}): JobHandle {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref();
  };
  function tick(): void {
    running = runSweepPass(storage, options)
      .then(
        () => undefined,
        (error: unknown) => {
          // runSweepPass does not throw; this keeps the schedule alive if that changes.
          console.error('[Sweep] pass failed:', sanitizeErrorMessage(error));
        }
      )
      .finally(() => {
        running = undefined;
        schedule(options.intervalMs ?? SWEEP_INTERVAL_MS);
      });
  }
  schedule(options.firstPassMs ?? SWEEP_FIRST_PASS_MS);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}

/** The job extension (src/http/extensions.ts): runs whenever the server has storage. */
export const sweepJob: JobExtension = {
  name: 'retention-sweep',
  start(ctx) {
    if (!ctx.storage) return undefined;
    return startSweepJob(ctx.storage);
  },
};
