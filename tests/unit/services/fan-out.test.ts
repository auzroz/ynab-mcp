/**
 * Fan-out reservation (#58): a multi-request tool takes its whole fan-out from the
 * rate limiter at once or is refused with the retry time before any request is
 * sent; tokens a reservation did not use are given back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { FAN_OUT, fanOutFor } from '../../../src/tools/fan-out.js';
import { handleToolCall, tools } from '../../../src/tools/index.js';
import { RateLimitError, formatErrorResponse } from '../../../src/utils/errors.js';

const HOUR = 60 * 60 * 1000;

function fakeClockLimiter(perHour: number, maxWaitMs = 2000) {
  let t = 1_000_000;
  const limiter = new RateLimiter(perHour, () => t, maxWaitMs);
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe('RateLimiter.acquireMany', () => {
  it('takes all tokens at once', async () => {
    const { limiter } = fakeClockLimiter(10);
    await expect(limiter.acquireMany(4)).resolves.toBe(4);
    expect(limiter.getStatus().available).toBe(6);
    expect(limiter.getStatus().sentLastHour).toBe(4);
  });

  it('takes nothing and reports the retry time when the bucket is short', async () => {
    const { limiter } = fakeClockLimiter(10);
    await limiter.acquireMany(8);
    const error = (await limiter.acquireMany(4).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    // Two tokens short at 10 per hour: 12 minutes.
    expect(error!.retryAfterMs).toBe(Math.ceil((2 / 10) * HOUR));
    expect(limiter.getStatus().available).toBe(2);
    expect(limiter.getStatus().rejectedLastHour).toBe(1);
  });

  it('succeeds once the refill covers it', async () => {
    const { limiter, advance } = fakeClockLimiter(10);
    await limiter.acquireMany(8);
    advance(Math.ceil(0.2 * HOUR));
    await expect(limiter.acquireMany(4)).resolves.toBe(4);
  });

  it('never waits, even with a wait allowance', async () => {
    const { limiter } = fakeClockLimiter(3600, 2000);
    await limiter.acquireMany(3600);
    await expect(limiter.acquireMany(2)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('refuses a request larger than the whole bucket, taking nothing', async () => {
    const { limiter } = fakeClockLimiter(5);
    await expect(limiter.acquireMany(9)).rejects.toBeInstanceOf(RateLimitError);
    expect(limiter.getStatus().available).toBe(5);
  });

  it('refuses while YNAB has said 429', async () => {
    const { limiter } = fakeClockLimiter(10);
    limiter.markExhaustedByYnab(5000);
    await expect(limiter.acquireMany(2)).rejects.toBeInstanceOf(RateLimitError);
    expect(limiter.getStatus().available).toBe(10);
  });

  it('does not jump a caller already waiting for a token', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(3600, Date.now, 2000);
      await limiter.acquireMany(3600);
      limiter.release(0);
      const waiter = limiter.acquire();
      // One token is due in 1 s; a reservation of 1 would take it from the waiter.
      await expect(limiter.acquireMany(1)).rejects.toBeInstanceOf(RateLimitError);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(waiter).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the active waiter\'s token in the retry time of a short reservation', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(3600, Date.now, 2000);
      await limiter.acquireMany(3600);
      const waiter = limiter.acquire(); // takes the token due in 1 s
      const error = (await limiter.acquireMany(2).catch((e: unknown) => e)) as RateLimitError;
      const retryMs = error.retryAfterMs ?? 0;
      // Two for the reservation plus one for the waiter, at one token per second.
      expect(retryMs).toBe(3000);
      await vi.advanceTimersByTimeAsync(1000);
      await waiter;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-positive or fractional count', async () => {
    const { limiter } = fakeClockLimiter(10);
    await expect(limiter.acquireMany(0)).rejects.toThrow();
    await expect(limiter.acquireMany(1.5)).rejects.toThrow();
  });

  it('release(n) gives n tokens back, capped at the bucket', async () => {
    const { limiter } = fakeClockLimiter(10);
    await limiter.acquireMany(5);
    limiter.release(3);
    expect(limiter.getStatus().available).toBe(8);
    expect(limiter.getStatus().sentLastHour).toBe(2);
    limiter.release(50);
    expect(limiter.getStatus().available).toBe(10);
  });
});

describe('YnabClient.withFanOut and handleToolCall', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { user: { id: 'u1' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function make(perHour: number): { client: YnabClient; limiter: RateLimiter } {
    const limiter = new RateLimiter(perHour);
    return { client: new YnabClient('token', 'b1', limiter, new Cache(300000), true, new AuditLog()), limiter };
  }

  it('draws the calls from the reservation and returns the unused tokens', async () => {
    const { client, limiter } = make(10);
    await client.withFanOut(5, async () => {
      await Promise.all([client.getUser(), client.getUser()]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limiter.getStatus().available).toBe(8);
    expect(limiter.getStatus().sentLastHour).toBe(2);
  });

  it('holds the whole reservation while the work runs', async () => {
    const { client, limiter } = make(10);
    let during = -1;
    await client.withFanOut(5, async () => {
      during = limiter.getStatus().available;
    });
    expect(during).toBe(5);
    expect(limiter.getStatus().available).toBe(10);
  });

  it('refuses before sending anything when the fan-out does not fit', async () => {
    const { client, limiter } = make(3);
    const work = vi.fn(async () => client.getUser());
    const error = await client.withFanOut(4, work).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(work).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.getStatus().available).toBe(3);
    const mapped = JSON.parse(formatErrorResponse(error)) as Record<string, unknown>;
    expect(mapped['type']).toBe('rate_limited');
    expect(mapped['retry_after_seconds']).toBeGreaterThanOrEqual(1);
  });

  it('refuses the rest of a fan-out once YNAB answers 429', async () => {
    const { client, limiter } = make(10);
    fetchMock.mockImplementationOnce(
      async () => new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } })
    );
    const error = await client
      .withFanOut(4, async () => {
        await client.getUser().catch(() => undefined);
        await client.getUser();
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    // Only the 429'd call was sent; the reserved tokens that went unused came back.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(limiter.getStatus().sentLastHour).toBe(1);
  });

  it('gives the tokens back when the work throws', async () => {
    const { client, limiter } = make(10);
    await expect(
      client.withFanOut(4, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(limiter.getStatus().available).toBe(10);
  });

  it('a call after the reservation ended draws from the limiter again', async () => {
    const { client, limiter } = make(10);
    let late: Promise<unknown> = Promise.resolve();
    await client.withFanOut(3, async () => {
      late = new Promise((resolve) => setTimeout(resolve, 5)).then(() => client.getUser());
    });
    await late;
    expect(limiter.getStatus().available).toBe(9);
  });

  it('one request does not reserve; concurrent fan-outs do not share a reservation', async () => {
    const { client, limiter } = make(10);
    await Promise.all([
      client.withFanOut(3, () => client.getUser()),
      client.withFanOut(3, () => client.getUser()),
    ]);
    expect(limiter.getStatus().available).toBe(8);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.withFanOut(1, () => client.getUser());
    expect(limiter.getStatus().available).toBe(7);
  });

  it('handleToolCall refuses a 13-request spending_trends whole, with no request sent', async () => {
    const { client, limiter } = make(12);
    const error = await handleToolCall('ynab_spending_trends', { months: 12 }, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.getStatus().available).toBe(12);
  });

  it('a tool with a single request is not reserved for', async () => {
    const { client, limiter } = make(1);
    await handleToolCall('ynab_get_user', {}, client);
    expect(limiter.getStatus().available).toBe(0);
  });
});

describe('fan-out table', () => {
  it('names only real tools', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const name of Object.keys(FAN_OUT)) expect(names.has(name)).toBe(true);
  });

  it('counts the reads a tool issues', () => {
    expect(fanOutFor('ynab_spending_trends', {})).toBe(7); // categories + 6 months
    expect(fanOutFor('ynab_spending_trends', { months: 12 })).toBe(13);
    expect(fanOutFor('ynab_budget_suggestions', {})).toBe(5);
    expect(fanOutFor('ynab_budget_suggestions', { months: 6 })).toBe(8);
    expect(fanOutFor('ynab_budget_vs_actuals', { include_previous: true })).toBe(3);
    expect(fanOutFor('ynab_transaction_search', {})).toBe(5);
    expect(fanOutFor('ynab_list_accounts', {})).toBe(1);
    expect(fanOutFor('constructor', {})).toBe(1);
  });

  it('clamps a malformed months argument', () => {
    expect(fanOutFor('ynab_spending_trends', { months: 9999 })).toBe(13);
    expect(fanOutFor('ynab_spending_trends', { months: 'x' })).toBe(7);
  });
});
