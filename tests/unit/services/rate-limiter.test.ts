/**
 * Rate Limiter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../../src/services/rate-limiter.js';

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
});
