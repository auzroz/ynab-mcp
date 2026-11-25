/**
 * #67a (D-4): RATE_LIMIT_STORE and MCP_REPLICAS. The store is `memory` unless
 * set to exactly `postgres`, which needs AUTH_MODE=oauth and
 * STORAGE_DRIVER=postgres; any other value refuses to start without echoing
 * it. MCP_REPLICAS only drives the startup warning, which names the setting.
 */

import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { replicaRateLimitWarning } from '../../../src/config/http/rate-limit-store.js';

const OAUTH_ENV = {
  AUTH_MODE: 'oauth',
  PUBLIC_URL: 'https://mcp.example.com',
  YNAB_OAUTH_CLIENT_ID: 'cid',
  YNAB_OAUTH_CLIENT_SECRET: 'csecret-value',
  ENCRYPTION_KEY: 'k'.repeat(44),
};
const POSTGRES_ENV = { ...OAUTH_ENV, STORAGE_DRIVER: 'postgres', DATABASE_URL: 'postgres://db.internal/ynab' };

function failure(env: Record<string, string>): string {
  try {
    loadHttpConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadHttpConfig to throw');
}

describe('RATE_LIMIT_STORE', () => {
  it('defaults to memory, unset or empty', () => {
    expect(loadHttpConfig(OAUTH_ENV).rateLimitStore).toBe('memory');
    expect(loadHttpConfig({ ...OAUTH_ENV, RATE_LIMIT_STORE: '' }).rateLimitStore).toBe('memory');
    expect(loadHttpConfig({ AUTH_MODE: 'header', RATE_LIMIT_STORE: 'memory' }).rateLimitStore).toBe('memory');
  });

  it('is postgres with AUTH_MODE=oauth and STORAGE_DRIVER=postgres', () => {
    expect(loadHttpConfig({ ...POSTGRES_ENV, RATE_LIMIT_STORE: 'postgres' }).rateLimitStore).toBe('postgres');
  });

  it.each(['Postgres', 'POSTGRES', ' postgres', 'redis', 'pg', 'true'])('refuses %j (exact values only)', (value) => {
    expect(failure({ ...POSTGRES_ENV, RATE_LIMIT_STORE: value })).toContain(
      'Invalid RATE_LIMIT_STORE. Expected: memory or postgres.'
    );
  });

  it('does not echo the value it refuses', () => {
    expect(failure({ ...POSTGRES_ENV, RATE_LIMIT_STORE: 'sentinel-store-value' })).not.toContain('sentinel-store-value');
  });

  it.each([
    ['the memory driver', { ...OAUTH_ENV }],
    ['the sqlite driver', { ...OAUTH_ENV, STORAGE_DRIVER: 'sqlite', SQLITE_PATH: '/data/db.sqlite' }],
    ['header mode', { AUTH_MODE: 'header', STORAGE_DRIVER: 'postgres', DATABASE_URL: 'postgres://db/x' }],
  ])('postgres is refused with %s', (_name, env) => {
    expect(failure({ ...env, RATE_LIMIT_STORE: 'postgres' })).toContain(
      'RATE_LIMIT_STORE=postgres requires AUTH_MODE=oauth and STORAGE_DRIVER=postgres'
    );
  });

  it('a bad STORAGE_DRIVER is reported once, not again as a RATE_LIMIT_STORE problem', () => {
    const msg = failure({ ...OAUTH_ENV, STORAGE_DRIVER: 'mysql', RATE_LIMIT_STORE: 'postgres' });
    expect(msg).toContain('STORAGE_DRIVER');
    expect(msg).not.toContain('RATE_LIMIT_STORE=postgres requires');
  });
});

describe('MCP_REPLICAS', () => {
  it('defaults to 1 and takes 1-1000', () => {
    expect(loadHttpConfig(OAUTH_ENV).mcpReplicas).toBe(1);
    expect(loadHttpConfig({ ...OAUTH_ENV, MCP_REPLICAS: '3' }).mcpReplicas).toBe(3);
    expect(loadHttpConfig({ ...OAUTH_ENV, MCP_REPLICAS: '1000' }).mcpReplicas).toBe(1000);
  });

  it.each(['0', '1001', '2.5', '3x', '-2'])('refuses %j', (value) => {
    expect(failure({ ...OAUTH_ENV, MCP_REPLICAS: value })).toContain('MCP_REPLICAS');
  });

  it('does not turn the shared store on', () => {
    expect(loadHttpConfig({ ...POSTGRES_ENV, MCP_REPLICAS: '4' }).rateLimitStore).toBe('memory');
  });
});

describe('the replica warning', () => {
  it('warns for more than one replica on per-process limits, naming RATE_LIMIT_STORE', () => {
    const warning = replicaRateLimitWarning({ mcpReplicas: 3, rateLimitStore: 'memory' });
    expect(warning).toMatch(/^WARNING: MCP_REPLICAS=3 but RATE_LIMIT_STORE=memory/);
    expect(warning).toContain('Set RATE_LIMIT_STORE=postgres');
    expect(warning).toContain('3 times RATE_LIMIT_PER_HOUR');
  });

  it('is silent for one replica, or with the shared store', () => {
    expect(replicaRateLimitWarning({ mcpReplicas: 1, rateLimitStore: 'memory' })).toBeUndefined();
    expect(replicaRateLimitWarning({ mcpReplicas: 5, rateLimitStore: 'postgres' })).toBeUndefined();
  });
});
