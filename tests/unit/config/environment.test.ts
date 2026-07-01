/**
 * Environment Configuration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../../src/config/environment.js';

const VALID_TOKEN = 'a'.repeat(40);
const VALID_UUID = '12345678-1234-1234-1234-123456789012';

describe('loadConfig', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all relevant env vars for a clean slate
    delete process.env['YNAB_ACCESS_TOKEN'];
    delete process.env['YNAB_BUDGET_ID'];
    delete process.env['LOG_LEVEL'];
    delete process.env['CACHE_TTL_MS'];
    delete process.env['RATE_LIMIT_PER_HOUR'];
    delete process.env['YNAB_READ_ONLY'];
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('access token', () => {
    it('loads a valid config with just a token, applying defaults', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;

      const config = loadConfig();

      expect(config.accessToken).toBe(VALID_TOKEN);
      expect(config.defaultBudgetId).toBeUndefined();
      expect(config.logLevel).toBe('info');
      expect(config.cacheTtlMs).toBe(300000);
      expect(config.rateLimitPerHour).toBe(180);
      expect(config.readOnly).toBe(true);
    });

    it('throws when the token is missing', () => {
      expect(() => loadConfig()).toThrow(/Configuration validation failed/);
      expect(() => loadConfig()).toThrow(/YNAB_ACCESS_TOKEN is required/);
    });

    it('throws when the token is an empty string', () => {
      process.env['YNAB_ACCESS_TOKEN'] = '';
      expect(() => loadConfig()).toThrow(/YNAB_ACCESS_TOKEN is required/);
    });
  });

  describe('defaultBudgetId', () => {
    it('accepts a valid UUID', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_BUDGET_ID'] = VALID_UUID;

      const config = loadConfig();
      expect(config.defaultBudgetId).toBe(VALID_UUID);
    });

    it('accepts the literal "last-used"', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_BUDGET_ID'] = 'last-used';

      const config = loadConfig();
      expect(config.defaultBudgetId).toBe('last-used');
    });

    it('treats an empty string budget id as undefined', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_BUDGET_ID'] = '';

      const config = loadConfig();
      expect(config.defaultBudgetId).toBeUndefined();
    });

    it('rejects an arbitrary non-UUID, non-"last-used" string', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_BUDGET_ID'] = 'not-a-uuid';

      expect(() => loadConfig()).toThrow(/Configuration validation failed/);
    });
  });

  describe('logLevel', () => {
    it('accepts valid log levels', () => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
        process.env['LOG_LEVEL'] = level;
        expect(loadConfig().logLevel).toBe(level);
      }
    });

    it('rejects an invalid log level', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['LOG_LEVEL'] = 'verbose';
      expect(() => loadConfig()).toThrow(/Configuration validation failed/);
    });
  });

  describe('YNAB_READ_ONLY boolean parsing', () => {
    it('defaults to true (read-only) when unset', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      expect(loadConfig().readOnly).toBe(true);
    });

    it('defaults to true when empty string', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_READ_ONLY'] = '';
      expect(loadConfig().readOnly).toBe(true);
    });

    it.each(['true', 'TRUE', '1', 'yes', 'YES'])('parses %s as true', (value) => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_READ_ONLY'] = value;
      expect(loadConfig().readOnly).toBe(true);
    });

    it.each(['false', 'FALSE', '0', 'no', 'NO'])('parses %s as false', (value) => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_READ_ONLY'] = value;
      expect(loadConfig().readOnly).toBe(false);
    });

    it('throws on a typo like "ture" rather than silently enabling writes', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_READ_ONLY'] = 'ture';
      expect(() => loadConfig()).toThrow(/Invalid boolean value "ture" for YNAB_READ_ONLY/);
    });

    it('throws on an arbitrary unrecognized value', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['YNAB_READ_ONLY'] = 'maybe';
      expect(() => loadConfig()).toThrow(/Expected: true, false, 1, 0, yes, or no/);
    });
  });

  describe('CACHE_TTL_MS integer parsing', () => {
    it('uses default when unset', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      expect(loadConfig().cacheTtlMs).toBe(300000);
    });

    it('parses a digit-only value', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['CACHE_TTL_MS'] = '60000';
      expect(loadConfig().cacheTtlMs).toBe(60000);
    });

    it('rejects a partial parse like "10ms"', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['CACHE_TTL_MS'] = '10ms';
      expect(() => loadConfig()).toThrow(/Invalid integer value "10ms" for CACHE_TTL_MS/);
    });

    it('rejects a negative value (non-digit characters)', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['CACHE_TTL_MS'] = '-5';
      expect(() => loadConfig()).toThrow(/Invalid integer value "-5"/);
    });

    it('rejects zero via schema (must be positive)', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['CACHE_TTL_MS'] = '0';
      expect(() => loadConfig()).toThrow(/Configuration validation failed/);
    });
  });

  describe('RATE_LIMIT_PER_HOUR integer parsing', () => {
    it('uses default when unset', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      expect(loadConfig().rateLimitPerHour).toBe(180);
    });

    it('parses a valid in-range value', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['RATE_LIMIT_PER_HOUR'] = '100';
      expect(loadConfig().rateLimitPerHour).toBe(100);
    });

    it('rejects a value above the max of 200', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['RATE_LIMIT_PER_HOUR'] = '500';
      expect(() => loadConfig()).toThrow(/Configuration validation failed/);
    });

    it('rejects zero (below min of 1)', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['RATE_LIMIT_PER_HOUR'] = '0';
      expect(() => loadConfig()).toThrow(/Configuration validation failed/);
    });

    it('rejects a non-integer string', () => {
      process.env['YNAB_ACCESS_TOKEN'] = VALID_TOKEN;
      process.env['RATE_LIMIT_PER_HOUR'] = '12.5';
      expect(() => loadConfig()).toThrow(/Invalid integer value "12.5"/);
    });
  });
});
