/**
 * HTTP transport in OAuth mode: health advertises the mode, the /mcp endpoint is
 * bearer-protected, and the AS metadata endpoint is served. Full MCP tool calls
 * are out of scope here. The YNAB network fns are mocked so no real calls occur.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>(
      '../../src/auth/ynab-oauth.js'
    );
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({
      accessToken: 'ya',
      refreshToken: 'yr',
      expiresAt: Date.now() + 7200_000,
    })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
    refreshAccessToken: vi.fn(async () => ({
      accessToken: 'ya2',
      refreshToken: 'yr2',
      expiresAt: Date.now() + 7200_000,
    })),
  };
});

import { createHttpApp } from '../../src/http.js';
import type { HttpConfig } from '../../src/config/environment.js';

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    port: 0,
    publicUrl: 'https://mcp.example.com',
    allowedHosts: undefined,
    allowedOrigins: undefined,
    enableDnsRebindingProtection: false,
    fallbackAccessToken: undefined,
    defaultBudgetId: undefined,
    readOnly: false,
    cacheTtlMs: 300000,
    rateLimitPerHour: 180,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    allowWrite: true,
    accessTokenTtlSec: 3600,
    authCodeTtlSec: 600,
    storageDriver: 'memory',
    sqlitePath: undefined,
    databaseUrl: undefined,
    ...overrides,
  };
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};

describe('HTTP transport (oauth mode)', () => {
  it('GET /health advertises authMode oauth', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.authMode).toBe('oauth');
  });

  it('POST /mcp initialize without a bearer token → 401', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.status).toBe(401);
  });

  it('GET /.well-known/oauth-authorization-server returns metadata with an issuer', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBeTruthy();
  });
});
