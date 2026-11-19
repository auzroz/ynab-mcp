/**
 * Stateless /mcp limits (src/config/http/limits.ts, ADR-0001 D6, D8, Q5):
 * the in-flight caps and the request ceiling parse strictly, are bounded,
 * keep their defaults consistent, and are listed in the one combined startup
 * error; the retired session settings still parse strictly, are otherwise
 * ignored, and are reported for the one-time warning.
 */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { deprecatedSessionSettingsWarning } from '../../../src/config/http/limits.js';

const HEADER_ENV = { AUTH_MODE: 'header' };

function failure(env: Record<string, string>): string {
  try {
    loadHttpConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadHttpConfig to refuse the configuration');
}

describe('defaults', () => {
  it('are 8 per user, 4 per (client, user), 64 per process and 60 s', () => {
    const c = loadHttpConfig(HEADER_ENV);
    expect(c.maxInflightPerUser).toBe(8);
    expect(c.maxInflightPerClient).toBe(4);
    expect(c.maxInflight).toBe(64);
    expect(c.requestTimeoutMs).toBe(60_000);
    expect(c.deprecatedSessionSettings).toEqual([]);
  });

  it('follow a smaller explicit cap, so lowering one never makes another invalid', () => {
    const small = loadHttpConfig({ ...HEADER_ENV, MCP_MAX_INFLIGHT: '3' });
    expect([small.maxInflight, small.maxInflightPerUser, small.maxInflightPerClient]).toEqual([3, 3, 3]);
    const perUser = loadHttpConfig({ ...HEADER_ENV, MCP_MAX_INFLIGHT_PER_USER: '2' });
    expect([perUser.maxInflightPerUser, perUser.maxInflightPerClient]).toEqual([2, 2]);
  });
});

describe('explicit values', () => {
  it('are read', () => {
    const c = loadHttpConfig({
      ...HEADER_ENV,
      MCP_MAX_INFLIGHT: '100',
      MCP_MAX_INFLIGHT_PER_USER: '64',
      MCP_MAX_INFLIGHT_PER_CLIENT: '64',
      MCP_REQUEST_TIMEOUT_MS: '300000',
    });
    expect([c.maxInflight, c.maxInflightPerUser, c.maxInflightPerClient, c.requestTimeoutMs]).toEqual([100, 64, 64, 300_000]);
  });

  it.each([
    ['MCP_MAX_INFLIGHT_PER_USER', '1-64', ['0', '65']],
    ['MCP_MAX_INFLIGHT_PER_CLIENT', '1-64', ['0', '65']],
    ['MCP_MAX_INFLIGHT', '1-1024', ['0', '1025']],
    ['MCP_REQUEST_TIMEOUT_MS', '5000-300000', ['4999', '300001']],
  ])('%s outside %s refuses to start, naming the variable and its range', (name, range, values) => {
    const [min, max] = range.split('-');
    for (const v of values) {
      const msg = failure({ ...HEADER_ENV, [name]: v });
      expect(msg, v).toContain(name);
      expect(msg, v).toContain(`between ${min} and ${max}`);
      expect(msg, v).not.toContain(`=${v}`);
    }
  });

  it.each([['10ms'], ['1e3'], ['-1'], [' 8'], ['8.0'], ['ten']])('strict parsing refuses %j', (value) => {
    for (const name of ['MCP_MAX_INFLIGHT_PER_USER', 'MCP_MAX_INFLIGHT_PER_CLIENT', 'MCP_MAX_INFLIGHT', 'MCP_REQUEST_TIMEOUT_MS']) {
      const msg = failure({ ...HEADER_ENV, [name]: value });
      expect(msg, name).toContain(name);
      expect(msg, name).not.toContain(value);
    }
  });

  it('a per-client cap above the per-user cap is refused (it could never bind)', () => {
    expect(failure({ ...HEADER_ENV, MCP_MAX_INFLIGHT_PER_USER: '4', MCP_MAX_INFLIGHT_PER_CLIENT: '5' })).toMatch(
      /MCP_MAX_INFLIGHT_PER_CLIENT: must not exceed MCP_MAX_INFLIGHT_PER_USER/
    );
    expect(loadHttpConfig({ ...HEADER_ENV, MCP_MAX_INFLIGHT_PER_USER: '4', MCP_MAX_INFLIGHT_PER_CLIENT: '4' }).maxInflightPerClient).toBe(4);
  });

  it('a per-user cap above the process-wide cap is refused', () => {
    expect(failure({ ...HEADER_ENV, MCP_MAX_INFLIGHT: '4', MCP_MAX_INFLIGHT_PER_USER: '5' })).toMatch(
      /MCP_MAX_INFLIGHT_PER_USER: must not exceed MCP_MAX_INFLIGHT/
    );
  });

  it('a bad cap is listed once, without a second misleading cross-check message', () => {
    const msg = failure({ ...HEADER_ENV, MCP_MAX_INFLIGHT: 'x', MCP_MAX_INFLIGHT_PER_USER: '64' });
    expect(msg).toContain('MCP_MAX_INFLIGHT');
    expect(msg).not.toMatch(/must not exceed/);
  });

  it('are listed in the one combined startup error with the other problems', () => {
    const msg = failure({ ...HEADER_ENV, MCP_MAX_INFLIGHT_PER_USER: '0', MCP_REQUEST_TIMEOUT_MS: '1', PORT: 'x' });
    expect(msg).toMatch(/^Invalid configuration \(3 problems\)/);
    expect(msg).toContain('MCP_MAX_INFLIGHT_PER_USER');
    expect(msg).toContain('MCP_REQUEST_TIMEOUT_MS');
    expect(msg).toContain('PORT');
  });
});

describe('retired session settings (D8)', () => {
  it('still refuse to start when malformed', () => {
    expect(failure({ ...HEADER_ENV, MCP_MAX_SESSIONS: 'lots' })).toContain('MCP_MAX_SESSIONS');
    expect(failure({ ...HEADER_ENV, MCP_SESSION_IDLE_TIMEOUT_MS: '0' })).toContain('MCP_SESSION_IDLE_TIMEOUT_MS');
  });

  it('are reported when set, so startup can warn once, and change no limit', () => {
    const c = loadHttpConfig({ ...HEADER_ENV, MCP_MAX_SESSIONS: '5', MCP_SESSION_IDLE_TIMEOUT_MS: '1000' });
    expect(c.deprecatedSessionSettings).toEqual(['MCP_MAX_SESSIONS', 'MCP_SESSION_IDLE_TIMEOUT_MS']);
    expect([c.maxInflight, c.maxInflightPerUser, c.maxInflightPerClient, c.requestTimeoutMs]).toEqual([64, 8, 4, 60_000]);
    // Empty counts as unset.
    expect(loadHttpConfig({ ...HEADER_ENV, MCP_MAX_SESSIONS_PER_USER: '' }).deprecatedSessionSettings).toEqual([]);
  });

  it('the warning names the settings set and their replacements, without values', () => {
    expect(deprecatedSessionSettingsWarning([])).toBeUndefined();
    const one = deprecatedSessionSettingsWarning(['MCP_MAX_SESSIONS']);
    expect(one).toMatch(/^WARNING: MCP_MAX_SESSIONS has no effect/);
    const all = deprecatedSessionSettingsWarning(['MCP_MAX_SESSIONS', 'MCP_MAX_SESSIONS_PER_USER', 'MCP_SESSION_IDLE_TIMEOUT_MS']);
    expect(all).toContain('MCP_MAX_SESSIONS, MCP_MAX_SESSIONS_PER_USER, MCP_SESSION_IDLE_TIMEOUT_MS have no effect');
    for (const replacement of ['MCP_MAX_INFLIGHT_PER_USER', 'MCP_MAX_INFLIGHT_PER_CLIENT', 'MCP_MAX_INFLIGHT', 'MCP_REQUEST_TIMEOUT_MS']) {
      expect(all).toContain(replacement);
    }
    expect(all).toContain('0.6');
  });
});
