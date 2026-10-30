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
import { makeHttpConfig } from './helpers/http-config.js';
import type { HttpConfig } from '../../src/config/environment.js';

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return makeHttpConfig({
    publicUrl: 'https://mcp.example.com',
    resourceUrl: 'https://mcp.example.com/mcp',
    readOnly: false,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    ...overrides,
  });
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

describe('OAuth protected-resource metadata (RFC 9728) and 401 challenges', () => {
  const expectedMeta = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

  it('serves path-aware metadata with the expected shape', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://mcp.example.com/'],
      scopes_supported: ['read-only', 'read-write'],
      bearer_methods_supported: ['header'],
      resource_name: 'YNAB MCP Server',
    });
    const as = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.authorization_servers[0]).toBe(as.body.issuer);
  });

  it('honors a custom MCP_RESOURCE_URL path and keeps the root alias', async () => {
    const app = await createHttpApp(makeConfig({ resourceUrl: 'https://mcp.example.com/api/mcp' }));
    const custom = await request(app).get('/.well-known/oauth-protected-resource/api/mcp');
    expect(custom.status).toBe(200);
    expect(custom.body.resource).toBe('https://mcp.example.com/api/mcp');
    const root = await request(app).get('/.well-known/oauth-protected-resource');
    expect(root.status).toBe(200);
    expect(root.body.resource).toBe('https://mcp.example.com/api/mcp');
    const unknown = await request(app).get('/.well-known/oauth-protected-resource/other');
    expect(unknown.status).toBe(404);
  });

  it('uses CORS and method rules consistent with the other well-known endpoints', async () => {
    const app = await createHttpApp(makeConfig());
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
    ]) {
      const get = await request(app).get(path).set('Origin', 'https://client.example');
      expect(get.headers['access-control-allow-origin']).toBe('*');
      const post = await request(app).post(path).send({});
      expect(post.status).toBe(405);
    }
  });

  it('401 without a token carries resource_metadata', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.status).toBe(401);
    const h = res.headers['www-authenticate'] ?? '';
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain('error="invalid_token"');
    expect(h).toContain(`resource_metadata="${expectedMeta}"`);
  });

  it('401 with an invalid token carries resource_metadata and no internals', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${expectedMeta}"`);
    expect(JSON.stringify(res.body)).not.toContain('not-a-real-token');
  });

  it('malformed Authorization scheme also gets the challenge', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).post('/mcp').set('Authorization', 'Basic abc').send(initializeBody);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('header-auth mode serves no protected-resource metadata and no challenge', async () => {
    const app = await createHttpApp(makeHttpConfig({ authMode: 'header', fallbackAccessToken: undefined }));
    const meta = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(meta.status).toBe(404);
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});
