/**
 * The retention sweep job (#54b, src/auth/sweep-job.ts): what a pass calls
 * and logs, the failure path, rescheduling, stop, and the extension.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Storage, SweepResult } from '../../../src/storage/types.js';
import { emptySweepCounts } from '../../../src/storage/retention.js';
import {
  runSweepPass,
  startSweepJob,
  sweepJob,
  SWEEP_INTERVAL_MS,
  SWEEP_FIRST_PASS_MS,
  SWEEP_STEPS,
  type SweepStep,
} from '../../../src/auth/sweep-job.js';
import { jobs as registeredJobs, type ExtensionContext } from '../../../src/http/extensions.js';
import { makeHttpConfig } from '../helpers/http-config.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SECRET = 'sentinel-refresh-token-0123456789abcdef';
const PATH_LEAK = '/private/var/db/ynab/secret.sqlite';

function storageWith(sweepExpired: () => Promise<SweepResult>): { storage: Storage; sweepExpired: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(sweepExpired);
  const sweepRateLimitRows = async (): Promise<Record<string, number>> => ({ rateLimitWindows: 0, rateLimitBuckets: 0 });
  return { storage: { sweepExpired: fn, sweepRateLimitRows } as unknown as Storage, sweepExpired: fn };
}

const ranWith = (deleted: Partial<ReturnType<typeof emptySweepCounts>>): SweepResult => ({
  ran: true,
  deleted: { ...emptySweepCounts(), ...deleted },
});

describe('one pass', () => {
  it('calls sweepExpired and logs the non-zero counts only', async () => {
    const { storage, sweepExpired } = storageWith(async () => ranWith({ refreshTokens: 3, abandonedClients: 1 }));
    const log = vi.fn();
    const result = await runSweepPass(storage, { log });
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 4, failed: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe('[Sweep] expired-rows: deleted refreshTokens=3 abandonedClients=1');
  });

  it('logs nothing when nothing was deleted, or when another replica holds the lock', async () => {
    const log = vi.fn();
    await runSweepPass(storageWith(async () => ranWith({})).storage, { log });
    await runSweepPass(storageWith(async () => ({ ran: false, deleted: emptySweepCounts() })).storage, { log });
    expect(log).not.toHaveBeenCalled();
  });

  it('on a failure logs a sanitized message (no token, no path), counts it, and still runs the other steps', async () => {
    const { storage } = storageWith(async () => {
      throw new Error(`connect failed at ${PATH_LEAK}: Bearer ${SECRET} password=hunter2`);
    });
    const later = vi.fn(async () => ({ pruned: 2 }));
    const steps: SweepStep[] = [...SWEEP_STEPS, { name: 'later-step', run: later }];
    const log = vi.fn();
    const result = await runSweepPass(storage, { steps, log });
    expect(result).toEqual({ deleted: 2, failed: 1 });
    expect(later).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('expired-rows failed');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PATH_LEAK);
    expect(logged).not.toContain('hunter2');
  });

  it('runs extra steps after the sweep (the seam #60b appends to)', async () => {
    const { storage } = storageWith(async () => ranWith({}));
    const order: string[] = [];
    const steps: SweepStep[] = [
      { name: 'a', run: async () => (order.push('a'), {}) },
      { name: 'b', run: async () => (order.push('b'), {}) },
    ];
    await runSweepPass(storage, { steps, log: () => undefined });
    expect(order).toEqual(['a', 'b']);
  });
});

describe('the job', () => {
  it('runs a first pass, then one per interval of 15 minutes', async () => {
    expect(SWEEP_INTERVAL_MS).toBe(15 * 60_000);
    vi.useFakeTimers();
    const { storage, sweepExpired } = storageWith(async () => ranWith({}));
    const handle = startSweepJob(storage, { log: () => undefined });
    expect(sweepExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SWEEP_FIRST_PASS_MS);
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweepExpired).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(sweepExpired).toHaveBeenCalledTimes(4);
    await handle.stop();
  });

  it('a failing pass is logged without the token or path, and the next one is scheduled', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { storage, sweepExpired } = storageWith(async () => {
      calls++;
      if (calls === 1) throw new Error(`boom ${PATH_LEAK} Bearer ${SECRET}`);
      return ranWith({ accessTokens: 1 });
    });
    const log = vi.fn();
    const handle = startSweepJob(storage, { firstPassMs: 10, intervalMs: 100, log });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweepExpired).toHaveBeenCalledTimes(2);
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('failed');
    expect(logged).toContain('accessTokens=1');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PATH_LEAK);
    await handle.stop();
  });

  it('a step that throws a non-Error is survived, and the schedule goes on', async () => {
    vi.useFakeTimers();
    const { storage } = storageWith(async () => ranWith({}));
    const run = vi.fn(async () => {
      throw SECRET;
    });
    const log = vi.fn();
    const handle = startSweepJob(storage, { firstPassMs: 10, intervalMs: 100, steps: [{ name: 's', run }], log });
    await vi.advanceTimersByTimeAsync(210);
    expect(run).toHaveBeenCalledTimes(3);
    await handle.stop();
  });

  it('stop() cancels the timer, waits for a pass in flight, and schedules nothing after', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { storage, sweepExpired } = storageWith(async () => {
      await gate;
      return ranWith({});
    });
    const handle = startSweepJob(storage, { firstPassMs: 10, intervalMs: 100, log: () => undefined });
    await vi.advanceTimersByTimeAsync(10);
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = Promise.resolve(handle.stop()).then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() before the first pass means no pass ever runs', async () => {
    vi.useFakeTimers();
    const { storage, sweepExpired } = storageWith(async () => ranWith({}));
    const handle = startSweepJob(storage, { log: () => undefined });
    await handle.stop();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);
    expect(sweepExpired).not.toHaveBeenCalled();
  });

  it('its timer is unref()d', async () => {
    const unref = vi.fn();
    const realSetTimeout = global.setTimeout;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSetTimeout(fn, ms);
      const real = t.unref.bind(t);
      t.unref = () => (unref(), real());
      return t;
    }) as typeof setTimeout);
    const { storage } = storageWith(async () => ranWith({}));
    const handle = startSweepJob(storage, { log: () => undefined });
    expect(unref).toHaveBeenCalledTimes(1);
    await handle.stop();
    spy.mockRestore();
  });
});

describe('the extension', () => {
  it('is registered', () => {
    expect(registeredJobs.map((j) => j.name)).toContain('retention-sweep');
  });

  it('starts only with storage', async () => {
    vi.useFakeTimers();
    const ctx = (storage: Storage | undefined): ExtensionContext => ({ config: makeHttpConfig(), storage });
    expect(sweepJob.start(ctx(undefined))).toBeUndefined();
    const { storage } = storageWith(async () => ranWith({}));
    const handle = sweepJob.start(ctx(storage));
    expect(handle).toBeDefined();
    await handle!.stop();
  });
});
