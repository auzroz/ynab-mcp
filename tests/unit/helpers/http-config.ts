import type { HttpConfig } from '../../../src/config/environment.js';

/** Build an HttpConfig with safe test defaults (header auth, memory storage, no network binding). */
export function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    port: 0,
    publicUrl: undefined,
    allowedHosts: undefined,
    allowedOrigins: undefined,
    enableDnsRebindingProtection: false,
    resourceUrl: undefined,
    maxSessions: 100,
    sessionIdleTimeoutMs: 30 * 60 * 1000,
    trustProxy: 0,
    fallbackAccessToken: undefined,
    defaultBudgetId: undefined,
    readOnly: true,
    cacheTtlMs: 300000,
    rateLimitPerHour: 180,
    authMode: 'header',
    oauthClientId: undefined,
    oauthClientSecret: undefined,
    encryptionKey: undefined,
    allowWrite: true,
    accessTokenTtlSec: 3600,
    authCodeTtlSec: 600,
    storageDriver: 'memory',
    sqlitePath: undefined,
    databaseUrl: undefined,
    ...overrides,
  };
}
