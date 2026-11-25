/**
 * Retention settings (#54b, src/config/http/retention.ts): defaults equal the
 * approved windows, strict integers within bounds, idle <= TTL, value-free
 * errors, and the policy the storage and the provider are built with.
 */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { retentionPolicyFromSettings } from '../../../src/config/http/retention.js';
import { DEFAULT_RETENTION } from '../../../src/auth/retention-defaults.js';

const HEADER_ENV = { AUTH_MODE: 'header' };

function failure(env: Record<string, string>): string {
  try {
    loadHttpConfig({ ...HEADER_ENV, ...env });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadHttpConfig to refuse the configuration');
}

const DAY = 86_400_000;

describe('defaults', () => {
  it('are the approved windows, and the policy built from them is DEFAULT_RETENTION', () => {
    const c = loadHttpConfig(HEADER_ENV);
    expect([c.refreshTokenIdleDays, c.refreshTokenTtlDays, c.abandonedClientHours, c.unusedClientDays]).toEqual([30, 90, 24, 90]);
    expect(c.auditRetentionDays).toBe(90);
    expect(retentionPolicyFromSettings(c)).toEqual(DEFAULT_RETENTION);
  });

  it('treat empty values as unset', () => {
    const c = loadHttpConfig({
      ...HEADER_ENV,
      MCP_REFRESH_TOKEN_IDLE_DAYS: '',
      MCP_REFRESH_TOKEN_TTL_DAYS: '',
      MCP_ABANDONED_CLIENT_HOURS: '',
      MCP_UNUSED_CLIENT_DAYS: '',
      AUDIT_RETENTION_DAYS: '',
    });
    expect(retentionPolicyFromSettings(c)).toEqual(DEFAULT_RETENTION);
  });
});

describe('explicit values', () => {
  it('are read and converted to milliseconds', () => {
    const c = loadHttpConfig({
      ...HEADER_ENV,
      MCP_REFRESH_TOKEN_IDLE_DAYS: '7',
      MCP_REFRESH_TOKEN_TTL_DAYS: '14',
      MCP_ABANDONED_CLIENT_HOURS: '2',
      MCP_UNUSED_CLIENT_DAYS: '30',
      AUDIT_RETENTION_DAYS: '365',
    });
    expect(retentionPolicyFromSettings(c)).toEqual({
      refreshTokenIdleMs: 7 * DAY,
      refreshTokenTtlMs: 14 * DAY,
      abandonedClientMs: 2 * 3_600_000,
      unusedClientMs: 30 * DAY,
      auditRetentionMs: 365 * DAY,
    });
  });

  it('accept the bounds: 1 to 3650 days, 1 to 87600 hours, idle equal to the TTL', () => {
    const low = loadHttpConfig({
      ...HEADER_ENV,
      MCP_REFRESH_TOKEN_IDLE_DAYS: '1',
      MCP_REFRESH_TOKEN_TTL_DAYS: '1',
      MCP_ABANDONED_CLIENT_HOURS: '1',
      MCP_UNUSED_CLIENT_DAYS: '1',
      AUDIT_RETENTION_DAYS: '1',
    });
    expect(retentionPolicyFromSettings(low).abandonedClientMs).toBe(3_600_000);
    expect(retentionPolicyFromSettings(low).auditRetentionMs).toBe(DAY);
    const top = loadHttpConfig({
      ...HEADER_ENV,
      MCP_REFRESH_TOKEN_IDLE_DAYS: '3650',
      MCP_REFRESH_TOKEN_TTL_DAYS: '3650',
      MCP_ABANDONED_CLIENT_HOURS: '87600',
      MCP_UNUSED_CLIENT_DAYS: '3650',
      AUDIT_RETENTION_DAYS: '3650',
    });
    expect(retentionPolicyFromSettings(top).refreshTokenTtlMs).toBe(3650 * DAY);
    expect(retentionPolicyFromSettings(top).auditRetentionMs).toBe(3650 * DAY);
  });
});

describe('invalid values', () => {
  it.each([
    ['MCP_REFRESH_TOKEN_IDLE_DAYS', ['0', '3651', '-1', '10d', '1.5', 'abc', ' 5']],
    ['MCP_REFRESH_TOKEN_TTL_DAYS', ['0', '3651', '-1', '90days', '1e2']],
    ['MCP_ABANDONED_CLIENT_HOURS', ['0', '87601', '-5', '24h', '0.5']],
    ['MCP_UNUSED_CLIENT_DAYS', ['0', '3651', '-1', '90d', 'ninety']],
    // 0 is refused: there is no "keep nothing" setting (#60b).
    ['AUDIT_RETENTION_DAYS', ['0', '3651', '-1', '90d', '1.5', '1e2', ' 90', 'forever']],

  ])('%s refuses %j, naming the variable and never the value', (name, values) => {
    for (const value of values) {
      const message = failure({ [name]: value });
      expect(message).toContain(name);
      if (value.length > 3) expect(message).not.toContain(value);
    }
  });

  it('refuses an idle window longer than the total window, whichever is set', () => {
    expect(failure({ MCP_REFRESH_TOKEN_IDLE_DAYS: '91' })).toContain('MCP_REFRESH_TOKEN_IDLE_DAYS must not exceed MCP_REFRESH_TOKEN_TTL_DAYS');
    expect(failure({ MCP_REFRESH_TOKEN_TTL_DAYS: '29' })).toContain('must not exceed');
    expect(failure({ MCP_REFRESH_TOKEN_IDLE_DAYS: '20', MCP_REFRESH_TOKEN_TTL_DAYS: '10' })).toContain('must not exceed');
  });

  it('lists a bad value once, without a second misleading idle/TTL message', () => {
    const message = failure({ MCP_REFRESH_TOKEN_IDLE_DAYS: 'x', MCP_REFRESH_TOKEN_TTL_DAYS: '10' });
    expect(message).not.toContain('must not exceed');
    expect(message).toContain('MCP_REFRESH_TOKEN_IDLE_DAYS');
  });

  it('reports every problem in one error', () => {
    const message = failure({ MCP_REFRESH_TOKEN_IDLE_DAYS: '0', MCP_UNUSED_CLIENT_DAYS: '9999', MCP_ABANDONED_CLIENT_HOURS: 'x' });
    for (const name of ['MCP_REFRESH_TOKEN_IDLE_DAYS', 'MCP_UNUSED_CLIENT_DAYS', 'MCP_ABANDONED_CLIENT_HOURS']) {
      expect(message).toContain(name);
    }
  });
});
