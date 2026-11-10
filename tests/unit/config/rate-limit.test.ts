/**
 * RATE_LIMIT_MAX_WAIT_MS parsing tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { parseRateLimitMaxWaitMs } from '../../../src/config/rate-limit.js';
import { loadConfig } from '../../../src/config/environment.js';

describe('parseRateLimitMaxWaitMs', () => {
  it('defaults to 2000 when unset or empty', () => {
    expect(parseRateLimitMaxWaitMs(undefined)).toBe(2000);
    expect(parseRateLimitMaxWaitMs('')).toBe(2000);
  });

  it('accepts 0 (never wait) through 60000', () => {
    expect(parseRateLimitMaxWaitMs('0')).toBe(0);
    expect(parseRateLimitMaxWaitMs('500')).toBe(500);
    expect(parseRateLimitMaxWaitMs('60000')).toBe(60000);
  });

  it.each(['2s', '-1', '1.5', ' 5', '1e3', 'abc', '60001', '99999999999999999999'])(
    'rejects %j and names the setting and range',
    (value) => {
      expect(() => parseRateLimitMaxWaitMs(value)).toThrow(/RATE_LIMIT_MAX_WAIT_MS.*0 to 60000/);
    }
  );
});

describe('loadConfig RATE_LIMIT_MAX_WAIT_MS', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is read into rateLimitMaxWaitMs', () => {
    process.env['YNAB_ACCESS_TOKEN'] = 'a'.repeat(40);
    delete process.env['RATE_LIMIT_MAX_WAIT_MS'];
    expect(loadConfig().rateLimitMaxWaitMs).toBe(2000);
    process.env['RATE_LIMIT_MAX_WAIT_MS'] = '0';
    expect(loadConfig().rateLimitMaxWaitMs).toBe(0);
    process.env['RATE_LIMIT_MAX_WAIT_MS'] = '2s';
    expect(() => loadConfig()).toThrow(/RATE_LIMIT_MAX_WAIT_MS/);
  });
});
