/**
 * Rate Limiter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter, parseRetryAfterMs } from '../../../src/services/rate-limiter.js';
import { RateLimitError } from '../../../src/utils/errors.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with full tokens', () => {
    const limiter = new RateLimiter(100);
    expect(limiter.getAvailableTokens()).toBe(100);
  });

  it('should use default of 180 tokens', () => {
    const limiter = new RateLimiter();
    expect(limiter.getAvailableTokens()).toBe(180);
  });

  it('should allow requests within rate limit', async () => {
    const limiter = new RateLimiter(10);

    // Should allow 10 requests
    for (let i = 0; i < 10; i++) {
      await limiter.acquire();
    }

    expect(limiter.getAvailableTokens()).toBe(0);
  });

  it('should decrement tokens on acquire', async () => {
    const limiter = new RateLimiter(100);
    await limiter.acquire();
    expect(limiter.getAvailableTokens()).toBe(99);
  });

  it('should report canAcquire correctly', async () => {
    const limiter = new RateLimiter(2);
    expect(limiter.canAcquire()).toBe(true);

    await limiter.acquire();
    expect(limiter.canAcquire()).toBe(true);

    await limiter.acquire();
    expect(limiter.canAcquire()).toBe(false);
  });

  it('should return zero wait time when tokens available', () => {
    const limiter = new RateLimiter(100);
    expect(limiter.getWaitTime()).toBe(0);
  });

  it('should calculate wait time when no tokens', async () => {
    const limiter = new RateLimiter(2);
    await limiter.acquire();
    await limiter.acquire();

    // Should need to wait since no tokens left
    expect(limiter.getWaitTime()).toBeGreaterThan(0);
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter(100); // 100 per hour

    // Use all tokens
    for (let i = 0; i < 100; i++) {
      await limiter.acquire();
    }
    expect(limiter.getAvailableTokens()).toBe(0);

    // Advance time by 36 seconds (should get 1 token back at 100/hour rate)
    vi.advanceTimersByTime(36 * 1000);

    expect(limiter.getAvailableTokens()).toBeGreaterThanOrEqual(1);
  });

  it('should not exceed max tokens on refill', async () => {
    const limiter = new RateLimiter(100);

    // Advance time by 2 hours
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    // Should still be capped at 100
    expect(limiter.getAvailableTokens()).toBe(100);
  });

  it('should give a token back on release, capped at the bucket size', async () => {
    const limiter = new RateLimiter(100);
    await limiter.acquire();
    limiter.release();
    expect(limiter.getAvailableTokens()).toBe(100);

    limiter.release();
    expect(limiter.getAvailableTokens()).toBe(100);
  });
});

describe('RateLimiter exhaustion by YNAB (injected clock)', () => {
  const HOUR = 3_600_000;
  let clock = 1_000_000;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000_000;
  });

  it('rejects acquire with RateLimitError for the Retry-After window, then recovers', async () => {
    const limiter = new RateLimiter(100, now);
    expect(limiter.markExhaustedByYnab('30')).toBe(30_000);

    await expect(limiter.acquire()).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfterMs: 30_000,
    });
    clock += 29_000;
    await expect(limiter.acquire()).rejects.toMatchObject({ retryAfterMs: 1_000 });
    clock += 1_000;
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('does not spend a token or record a request while rejecting', async () => {
    const limiter = new RateLimiter(100, now);
    limiter.markExhaustedByYnab(5_000);
    await expect(limiter.acquire()).rejects.toBeInstanceOf(Error);
    expect(limiter.getAvailableTokens()).toBe(100);
  });

  it('without Retry-After uses the time until the oldest request in the hour expires', async () => {
    const limiter = new RateLimiter(100, now);
    await limiter.acquire(); // sent at t0
    clock += 20 * 60_000;
    await limiter.acquire();
    clock += 10 * 60_000; // oldest is 30 minutes old
    expect(limiter.markExhaustedByYnab()).toBe(30 * 60_000);
    expect(limiter.markExhaustedByYnab(null)).toBe(30 * 60_000);
  });

  it('falls back to a 60 second default when no request is recorded', () => {
    const limiter = new RateLimiter(100, now);
    expect(limiter.markExhaustedByYnab()).toBe(60_000);
  });

  it('ignores requests older than an hour and unusable Retry-After values', async () => {
    const limiter = new RateLimiter(100, now);
    await limiter.acquire();
    clock += HOUR + 1;
    expect(limiter.markExhaustedByYnab('soon')).toBe(60_000);
  });

  it('treats Retry-After: 0 and a past HTTP date as retry now (1s floor), not as absent', async () => {
    const limiter = new RateLimiter(100, now);
    await limiter.acquire(); // a request in the rolling hour; the fallback would be ~1h
    expect(limiter.markExhaustedByYnab('0')).toBe(1_000);
    clock += 1_000;
    const past = new Date(clock - 60_000).toUTCString();
    expect(limiter.markExhaustedByYnab(past)).toBe(1_000);
    clock += 1_000;
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('clamps the window to between 1 second and 1 hour', () => {
    const limiter = new RateLimiter(100, now);
    expect(limiter.markExhaustedByYnab(10)).toBe(1_000);
    clock += 10_000;
    expect(limiter.markExhaustedByYnab(10 * HOUR)).toBe(HOUR);
  });

  it('never shortens a window already in force', () => {
    const limiter = new RateLimiter(100, now);
    limiter.markExhaustedByYnab('120');
    clock += 10_000;
    expect(limiter.markExhaustedByYnab('5')).toBe(110_000);
  });

  it('reports the exhaustion in getStatus and blocks canMakeRequest', async () => {
    const limiter = new RateLimiter(100, now);
    expect(limiter.getStatus().ynabExhausted).toBeUndefined();

    limiter.markExhaustedByYnab('90');
    clock += 30_000;
    const status = limiter.getStatus();
    expect(status.canMakeRequest).toBe(false);
    expect(status.waitTimeMs).toBe(60_000);
    expect(status.ynabExhausted).toEqual({
      active: true,
      exhaustedAtMs: 1_000_000,
      untilMs: 1_090_000,
      retryAfterMs: 60_000,
    });

    clock += 60_000;
    const after = limiter.getStatus();
    expect(after.canMakeRequest).toBe(true);
    expect(after.ynabExhausted).toMatchObject({ active: false, retryAfterMs: 0, exhaustedAtMs: 1_000_000 });
  });

  it('release removes the request from the rolling window', async () => {
    const limiter = new RateLimiter(100, now);
    await limiter.acquire();
    limiter.release();
    expect(limiter.markExhaustedByYnab()).toBe(60_000);
  });

  it('RateLimitError carries the wait', async () => {
    const limiter = new RateLimiter(100, now);
    limiter.markExhaustedByYnab('10');
    const error = await limiter.acquire().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and HTTP dates relative to the given time', () => {
    expect(parseRetryAfterMs('120', 0)).toBe(120_000);
    const base = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:29:00 GMT', base)).toBe(60_000);
  });

  it('returns undefined for absent or junk values, and 0 for retry-now values', () => {
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, 0)).toBeUndefined();
    expect(parseRetryAfterMs('  ', 0)).toBeUndefined();
    expect(parseRetryAfterMs('later', 0)).toBeUndefined();
    expect(parseRetryAfterMs('0', 0)).toBe(0);
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2026-01-01'))).toBe(0);
  });
});
