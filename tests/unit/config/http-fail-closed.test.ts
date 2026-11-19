/**
 * Fail-closed HTTP configuration (#56): every rule, through loadHttpConfig(env)
 * with a plain env object (process.env is never touched).
 */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { isLoopbackBind } from '../../../src/config/http/server.js';

const OAUTH_ENV = {
  AUTH_MODE: 'oauth',
  PUBLIC_URL: 'https://mcp.example.com',
  YNAB_OAUTH_CLIENT_ID: 'cid',
  YNAB_OAUTH_CLIENT_SECRET: 'csecret-value',
  ENCRYPTION_KEY: 'k'.repeat(44),
};
const HEADER_ENV = { AUTH_MODE: 'header' };

/** The message loadHttpConfig throws for `env`. */
function failure(env: Record<string, string>): string {
  try {
    loadHttpConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadHttpConfig to throw');
}

describe('AUTH_MODE', () => {
  it('is required', () => {
    expect(failure({})).toMatch(/AUTH_MODE is required in HTTP mode.*oauth or header/);
    expect(failure({ AUTH_MODE: '' })).toMatch(/AUTH_MODE is required/);
  });
  it('rejects an unknown value without echoing it', () => {
    const msg = failure({ AUTH_MODE: 'oauth2-secret-typo' });
    expect(msg).toMatch(/Invalid value for AUTH_MODE/);
    expect(msg).not.toContain('oauth2-secret-typo');
  });
  it('is not inferred from the OAuth variables', () => {
    const { AUTH_MODE: _omit, ...withoutMode } = OAUTH_ENV;
    expect(() => loadHttpConfig(withoutMode)).toThrow(/AUTH_MODE is required/);
  });
  it('accepts oauth and header, case-insensitively', () => {
    expect(loadHttpConfig(OAUTH_ENV).authMode).toBe('oauth');
    expect(loadHttpConfig({ AUTH_MODE: 'HEADER' }).authMode).toBe('header');
  });
  it.each(['YNAB_OAUTH_CLIENT_ID', 'YNAB_OAUTH_CLIENT_SECRET', 'ENCRYPTION_KEY', 'PUBLIC_URL'])(
    'oauth refuses to start without %s, naming it', (missing) => {
      const env: Record<string, string> = { ...OAUTH_ENV };
      delete env[missing];
      expect(failure(env)).toContain(missing);
    });
  it('oauth lists every missing OAuth variable at once', () => {
    const msg = failure({ AUTH_MODE: 'oauth' });
    for (const name of ['YNAB_OAUTH_CLIENT_ID', 'YNAB_OAUTH_CLIENT_SECRET', 'ENCRYPTION_KEY', 'PUBLIC_URL']) {
      expect(msg).toContain(name);
    }
  });
});

describe('oauth refuses a static YNAB identity', () => {
  it('YNAB_ACCESS_TOKEN', () => {
    const msg = failure({ ...OAUTH_ENV, YNAB_ACCESS_TOKEN: 'dummy-ynab-token' });
    expect(msg).toMatch(/YNAB_ACCESS_TOKEN must not be set when AUTH_MODE=oauth/);
    expect(msg).not.toContain('dummy-ynab-token');
  });
  it('YNAB_BUDGET_ID', () => {
    expect(failure({ ...OAUTH_ENV, YNAB_BUDGET_ID: 'last-used' })).toMatch(/YNAB_BUDGET_ID must not be set when AUTH_MODE=oauth/);
  });
  it('reports both in one message', () => {
    const msg = failure({ ...OAUTH_ENV, YNAB_ACCESS_TOKEN: 'x', YNAB_BUDGET_ID: 'y' });
    expect(msg).toMatch(/2 problems/);
  });
  it('header mode still takes them', () => {
    const c = loadHttpConfig({ ...HEADER_ENV, YNAB_BUDGET_ID: 'last-used', MCP_BIND_HOST: '127.0.0.1' });
    expect(c.defaultBudgetId).toBe('last-used');
  });
});

describe('YNAB_OAUTH_ALLOW_WRITE', () => {
  it('defaults to false', () => {
    expect(loadHttpConfig(OAUTH_ENV).allowWrite).toBe(false);
    expect(loadHttpConfig(HEADER_ENV).allowWrite).toBe(false);
  });
  it('opts in with true, and a typo is refused rather than read as false or true', () => {
    expect(loadHttpConfig({ ...OAUTH_ENV, YNAB_OAUTH_ALLOW_WRITE: 'true' }).allowWrite).toBe(true);
    expect(failure({ ...OAUTH_ENV, YNAB_OAUTH_ALLOW_WRITE: 'ture' })).toMatch(/YNAB_OAUTH_ALLOW_WRITE/);
  });
});

describe('TRUST_CF_CONNECTING_IP and the /register limits (#59)', () => {
  it('defaults: CF-Connecting-IP untrusted, 100 per IP and 20 per redirect host', () => {
    const c = loadHttpConfig(OAUTH_ENV);
    expect([c.trustCfConnectingIp, c.registerRateLimitPerIp, c.registerRateLimitPerHost]).toEqual([false, 100, 20]);
  });
  it('is on only with true; a typo is refused, naming the variable and not the value', () => {
    expect(loadHttpConfig({ ...OAUTH_ENV, TRUST_CF_CONNECTING_IP: 'true' }).trustCfConnectingIp).toBe(true);
    const msg = failure({ ...OAUTH_ENV, TRUST_CF_CONNECTING_IP: 'ture' });
    expect(msg).toMatch(/TRUST_CF_CONNECTING_IP/);
    expect(msg).not.toContain('ture');
  });
  it('is part of the combined startup error', () => {
    const msg = failure({ ...OAUTH_ENV, TRUST_CF_CONNECTING_IP: 'ture', REGISTER_RATE_LIMIT_PER_HOST: '0', TRUST_PROXY: '99' });
    expect(msg).toMatch(/TRUST_CF_CONNECTING_IP/);
    expect(msg).toMatch(/REGISTER_RATE_LIMIT_PER_HOST/);
    expect(msg).toMatch(/TRUST_PROXY/);
  });
});

describe('numeric bounds', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['RATE_LIMIT_PER_HOUR', ['0', '196', '1000'], ['1', '195']],
    ['MCP_ACCESS_TOKEN_TTL_SEC', ['0', '59', '3601'], ['60', '3600']],
    ['MCP_AUTH_CODE_TTL_SEC', ['0', '29', '601'], ['30', '600']],
    ['MCP_MAX_SESSIONS', ['0'], ['1']],
    ['MCP_MAX_SESSIONS_PER_USER', ['0'], ['1']],
    ['MCP_SESSION_IDLE_TIMEOUT_MS', ['0'], ['1']],
    ['MCP_MAX_INFLIGHT', ['0', '1025'], ['1', '1024']],
    ['MCP_MAX_INFLIGHT_PER_USER', ['0', '65'], ['1', '64']],
    // Its upper bound (64) also needs a per-user cap that high: http-config-limits.test.ts.
    ['MCP_MAX_INFLIGHT_PER_CLIENT', ['0', '65'], ['1', '4']],
    ['MCP_REQUEST_TIMEOUT_MS', ['0', '4999', '300001'], ['5000', '300000']],
    ['CACHE_TTL_MS', ['0'], ['1']],
    ['PORT', ['0', '65536'], ['1', '65535']],
    ['TRUST_PROXY', ['11'], ['0', '10']],
    ['REGISTER_RATE_LIMIT_PER_IP', ['0', '100001'], ['1', '100000']],
    ['REGISTER_RATE_LIMIT_PER_HOST', ['0', '100001'], ['1', '100000']],
  ];
  it.each(cases)('%s: out of range refuses to start, naming the variable and range', (name, bad) => {
    for (const v of bad) {
      const msg = failure({ ...OAUTH_ENV, [name]: v });
      expect(msg, `${name}=${v}`).toContain(name);
      expect(msg, `${name}=${v}`).toMatch(/between \d+ and \d+|>= 1/);
    }
  });
  it.each(cases)('%s: the bounds themselves are accepted', (name, _bad, good) => {
    for (const v of good) expect(() => loadHttpConfig({ ...OAUTH_ENV, [name]: v }), `${name}=${v}`).not.toThrow();
  });
  it('the RATE_LIMIT_PER_HOUR message states 1 and 195', () => {
    expect(failure({ ...OAUTH_ENV, RATE_LIMIT_PER_HOUR: '200' })).toMatch(/RATE_LIMIT_PER_HOUR.*between 1 and 195/);
  });
  it('does not echo the rejected value', () => {
    expect(failure({ ...OAUTH_ENV, RATE_LIMIT_PER_HOUR: '987654' })).not.toContain('987654');
  });
  it('the defaults are inside the bounds', () => {
    const c = loadHttpConfig(OAUTH_ENV);
    expect([c.rateLimitPerHour, c.accessTokenTtlSec, c.authCodeTtlSec]).toEqual([180, 3600, 600]);
  });
});

describe('one combined startup error', () => {
  it('lists every problem, once each, with no values', () => {
    const msg = failure({
      AUTH_MODE: 'oauth',
      PUBLIC_URL: 'https://mcp.example.com',
      YNAB_OAUTH_CLIENT_SECRET: 'super-secret-value',
      YNAB_ACCESS_TOKEN: 'dummy-ynab-token',
      RATE_LIMIT_PER_HOUR: '5000',
      MCP_AUTH_CODE_TTL_SEC: '10ms',
      YNAB_OAUTH_ALLOW_WRITE: 'ture',
      STORAGE_DRIVER: 'mysql',
      LOG_LEVEL: 'loud',
    });
    expect(msg).toMatch(/^Invalid configuration \(\d+ problems\):\n/);
    for (const name of [
      'YNAB_OAUTH_CLIENT_ID', 'ENCRYPTION_KEY', 'YNAB_ACCESS_TOKEN', 'RATE_LIMIT_PER_HOUR',
      'MCP_AUTH_CODE_TTL_SEC', 'YNAB_OAUTH_ALLOW_WRITE', 'STORAGE_DRIVER', 'LOG_LEVEL',
    ]) {
      expect(msg).toContain(name);
    }
    for (const value of ['super-secret-value', 'dummy-ynab-token', '5000', 'mysql', 'loud']) {
      expect(msg).not.toContain(value);
    }
  });
  it('is one error even for a single problem', () => {
    expect(failure({ AUTH_MODE: 'header', PORT: 'abc' })).toMatch(/^Invalid configuration \(1 problem\):\n {2}- .*PORT/);
  });
  it('keeps going after a bad value, so a later setting is still checked', () => {
    const msg = failure({ ...HEADER_ENV, MCP_MAX_SESSIONS: 'x', MCP_SESSION_IDLE_TIMEOUT_MS: '0' });
    expect(msg).toContain('MCP_MAX_SESSIONS');
    expect(msg).toContain('MCP_SESSION_IDLE_TIMEOUT_MS');
  });
});

describe('header mode with YNAB_ACCESS_TOKEN (bind rule)', () => {
  const withToken = { ...HEADER_ENV, YNAB_ACCESS_TOKEN: 'dummy-ynab-token' };
  it('refuses the default bind (all interfaces)', () => {
    const msg = failure(withToken);
    expect(msg).toMatch(/not bound to loopback/);
    expect(msg).toContain('MCP_ALLOW_ANONYMOUS_FALLBACK=true');
    expect(msg).not.toContain('dummy-ynab-token');
  });
  it('refuses an explicit non-loopback bind', () => {
    expect(failure({ ...withToken, MCP_BIND_HOST: '0.0.0.0' })).toMatch(/not bound to loopback/);
    expect(failure({ ...withToken, MCP_BIND_HOST: '10.0.0.5' })).toMatch(/not bound to loopback/);
  });
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1'])('accepts loopback bind %s', (host) => {
    expect(loadHttpConfig({ ...withToken, MCP_BIND_HOST: host }).bindHost).toBe(host);
  });
  it('refuses a bracketed IPv6 bind (listen() would resolve it as a hostname) and junk, without echoing it', () => {
    const msg = failure({ ...HEADER_ENV, MCP_BIND_HOST: '[::1]' });
    expect(msg).toMatch(/MCP_BIND_HOST.*without brackets/);
    const junk = failure({ ...HEADER_ENV, MCP_BIND_HOST: 'pa ss:word@host' });
    expect(junk).toMatch(/MCP_BIND_HOST/);
    expect(junk).not.toContain('pa ss');
  });
  it('accepts a hostname bind, which is not loopback unless localhost', () => {
    expect(loadHttpConfig({ ...HEADER_ENV, MCP_BIND_HOST: 'app.internal' }).bindHost).toBe('app.internal');
    expect(failure({ ...withToken, MCP_BIND_HOST: 'app.internal' })).toMatch(/not bound to loopback/);
  });
  it('accepts a non-loopback bind with MCP_ALLOW_ANONYMOUS_FALLBACK=true', () => {
    const c = loadHttpConfig({ ...withToken, MCP_ALLOW_ANONYMOUS_FALLBACK: 'true' });
    expect(c.allowAnonymousFallback).toBe(true);
    expect(c.fallbackAccessToken).toBe('dummy-ynab-token');
  });
  it('does not apply without YNAB_ACCESS_TOKEN (each request brings its own token)', () => {
    expect(() => loadHttpConfig(HEADER_ENV)).not.toThrow();
  });
  it('does not apply in oauth mode (which refuses the token on its own)', () => {
    expect(failure({ ...OAUTH_ENV, YNAB_ACCESS_TOKEN: 'x' })).not.toMatch(/loopback/);
  });
  it('isLoopbackBind', () => {
    expect(isLoopbackBind(undefined)).toBe(false);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(isLoopbackBind('::')).toBe(false);
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
  });
});

describe('storage location in oauth mode', () => {
  it('sqlite needs SQLITE_PATH and postgres needs DATABASE_URL, listed with other problems', () => {
    const msg = failure({ ...OAUTH_ENV, STORAGE_DRIVER: 'sqlite', RATE_LIMIT_PER_HOUR: '0' });
    expect(msg).toContain('SQLITE_PATH');
    expect(msg).toContain('RATE_LIMIT_PER_HOUR');
    expect(failure({ ...OAUTH_ENV, STORAGE_DRIVER: 'postgres' })).toContain('DATABASE_URL');
  });
  it('accepts them when set, and header mode does not need them', () => {
    expect(() => loadHttpConfig({ ...OAUTH_ENV, STORAGE_DRIVER: 'sqlite', SQLITE_PATH: '/data/x.db' })).not.toThrow();
    expect(() => loadHttpConfig({ ...HEADER_ENV, STORAGE_DRIVER: 'sqlite' })).not.toThrow();
  });
});

describe('LOG_LEVEL in HTTP mode', () => {
  it('defaults to info and accepts the four levels', () => {
    expect(loadHttpConfig(HEADER_ENV).logLevel).toBe('info');
    for (const l of ['debug', 'info', 'warn', 'ERROR']) {
      expect(loadHttpConfig({ ...HEADER_ENV, LOG_LEVEL: l }).logLevel).toBe(l.toLowerCase());
    }
  });
  it('refuses another value', () => {
    expect(failure({ ...HEADER_ENV, LOG_LEVEL: 'trace' })).toMatch(/LOG_LEVEL/);
  });
});

describe('loadHttpConfig composition', () => {
  it('reads the env it is given, not process.env', () => {
    process.env['MCP_BIND_HOST'] = '10.9.9.9';
    try {
      expect(loadHttpConfig(HEADER_ENV).bindHost).toBeUndefined();
    } finally {
      delete process.env['MCP_BIND_HOST'];
    }
  });
  it('returns every slice', () => {
    const c = loadHttpConfig(OAUTH_ENV);
    expect(Object.keys(c).sort()).toEqual([
      'accessTokenTtlSec', 'allowAnonymousFallback', 'allowWrite', 'allowedHosts', 'allowedOrigins', 'authCodeTtlSec',
      'authMode', 'bindHost', 'cacheTtlMs', 'databaseUrl', 'defaultBudgetId', 'deprecatedSessionSettings',
      'enableDnsRebindingProtection', 'encryptionKey', 'fallbackAccessToken', 'logLevel', 'maxInflight',
      'maxInflightPerClient', 'maxInflightPerUser', 'maxSessions', 'maxSessionsPerUser', 'oauthClientId',
      'oauthClientSecret', 'port', 'privateUseSchemes', 'publicUrl', 'rateLimitMaxWaitMs', 'rateLimitPerHour',
      'readOnly', 'registerRateLimitPerHost', 'registerRateLimitPerIp', 'requestTimeoutMs', 'resourceUrl',
      'securityContacts', 'securityPolicyUrl', 'sessionIdleTimeoutMs', 'sqlitePath', 'storageDriver', 'tokenPepper',
      'trustCfConnectingIp', 'trustLoopbackRedirects', 'trustProxy', 'verifiedRedirectUris',
    ]);
  });
});
