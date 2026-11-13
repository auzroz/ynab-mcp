/** Circuit breaker (#58): 20 consecutive failures within 60 s open it for 30 s, then one probe. */

import { describe, it, expect } from 'vitest';
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_OPEN_MS,
  BREAKER_WINDOW_MS,
  CircuitBreaker,
} from '../../../src/services/circuit-breaker.js';
import { CircuitOpenError } from '../../../src/utils/errors.js';

function make(overrides: ConstructorParameters<typeof CircuitBreaker>[0] = {}) {
  let t = 1_000_000;
  const breaker = new CircuitBreaker({ now: () => t, ...overrides });
  return { breaker, advance: (ms: number) => (t += ms) };
}

function fail(breaker: CircuitBreaker, times: number): void {
  for (let i = 0; i < times; i++) breaker.admit().failure();
}

describe('CircuitBreaker', () => {
  it('uses the issue defaults: 20 failures, 60 s window, 30 s open', () => {
    expect(BREAKER_FAILURE_THRESHOLD).toBe(20);
    expect(BREAKER_WINDOW_MS).toBe(60_000);
    expect(BREAKER_OPEN_MS).toBe(30_000);
  });

  it('stays closed below the threshold and opens on the 20th consecutive failure', () => {
    const { breaker } = make();
    fail(breaker, 19);
    expect(breaker.state()).toBe('closed');
    breaker.admit().failure();
    expect(breaker.state()).toBe('open');
    expect(() => breaker.admit()).toThrow(CircuitOpenError);
  });

  it('a success in between resets the streak', () => {
    const { breaker } = make();
    fail(breaker, 19);
    breaker.admit().success();
    fail(breaker, 19);
    expect(breaker.state()).toBe('closed');
  });

  it('failures spread over more than the window do not accumulate', () => {
    const { breaker, advance } = make();
    fail(breaker, 10);
    advance(BREAKER_WINDOW_MS + 1);
    fail(breaker, 10);
    expect(breaker.state()).toBe('closed');
    fail(breaker, 10);
    expect(breaker.state()).toBe('open');
  });

  it('fails fast for 30 s, reporting the time left', () => {
    const { breaker, advance } = make();
    fail(breaker, 20);
    advance(10_000);
    try {
      breaker.admit();
      expect.unreachable();
    } catch (error) {
      expect((error as CircuitOpenError).retryAfterMs).toBe(20_000);
    }
  });

  it('half-opens after 30 s with one probe at a time; a successful probe closes it', () => {
    const { breaker, advance } = make();
    fail(breaker, 20);
    advance(BREAKER_OPEN_MS);
    expect(breaker.state()).toBe('half_open');
    const probe = breaker.admit();
    expect(() => breaker.admit()).toThrow(CircuitOpenError);
    probe.success();
    expect(breaker.state()).toBe('closed');
    expect(() => breaker.admit()).not.toThrow();
  });

  it('a failed probe reopens it for another 30 s', () => {
    const { breaker, advance } = make();
    fail(breaker, 20);
    advance(BREAKER_OPEN_MS);
    breaker.admit().failure();
    expect(breaker.state()).toBe('open');
    advance(BREAKER_OPEN_MS - 1);
    expect(() => breaker.admit()).toThrow(CircuitOpenError);
    advance(1);
    expect(() => breaker.admit()).not.toThrow();
  });

  it('a cancelled probe lets the next request probe', () => {
    const { breaker, advance } = make();
    fail(breaker, 20);
    advance(BREAKER_OPEN_MS);
    breaker.admit().cancel();
    expect(() => breaker.admit()).not.toThrow();
  });

  it('ignores a straggler that was admitted before it opened', () => {
    const { breaker } = make({ threshold: 2 });
    const straggler = breaker.admit();
    fail(breaker, 2);
    expect(breaker.state()).toBe('open');
    straggler.success();
    expect(breaker.state()).toBe('open');
  });

  it('settles an attempt only once', () => {
    const { breaker } = make({ threshold: 2 });
    const attempt = breaker.admit();
    attempt.failure();
    attempt.failure();
    expect(breaker.status().consecutiveFailures).toBe(1);
  });

  it('rejects invalid settings', () => {
    expect(() => new CircuitBreaker({ threshold: 0 })).toThrow();
    expect(() => new CircuitBreaker({ openMs: Number.NaN })).toThrow();
  });
});
