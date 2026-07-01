/**
 * HTTP transport wiring: health, auth gate, and session validation.
 * (Full MCP protocol round-trips are exercised by integration tests later.)
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHttpApp } from '../../src/http.js';
import type { HttpConfig } from '../../src/config/environment.js';

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    port: 0,
    publicUrl: undefined,
    allowedHosts: undefined,
    allowedOrigins: undefined,
    enableDnsRebindingProtection: false,
    fallbackAccessToken: undefined,
    defaultBudgetId: undefined,
    readOnly: true,
    cacheTtlMs: 300000,
    rateLimitPerHour: 180,
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

describe('HTTP transport', () => {
  it('GET /health returns ok', async () => {
    const app = createHttpApp(makeConfig());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.transport).toBe('http');
  });

  it('POST /mcp with a non-initialize request and no session → 400', async () => {
    const app = createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(400);
  });

  it('POST /mcp initialize with no YNAB token → 401', async () => {
    const app = createHttpApp(makeConfig({ fallbackAccessToken: undefined }));
    const res = await request(app).post('/mcp').send(initializeBody);
    expect(res.status).toBe(401);
  });

  it('GET /mcp without a session id → 400', async () => {
    const app = createHttpApp(makeConfig());
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(400);
  });

  it('DELETE /mcp without a session id → 400', async () => {
    const app = createHttpApp(makeConfig());
    const res = await request(app).delete('/mcp');
    expect(res.status).toBe(400);
  });

  it('POST /mcp initialize with a token opens a session (returns Mcp-Session-Id)', async () => {
    const app = createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);

    // A successful initialize issues a session id header regardless of body framing.
    expect(res.status).toBeLessThan(400);
    expect(res.headers['mcp-session-id']).toBeDefined();
  });

  it('DELETE /mcp with a valid session id tears the session down', async () => {
    const app = createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
    const init = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toBeDefined();

    const del = await request(app).delete('/mcp').set('mcp-session-id', sessionId);
    expect(del.status).toBeLessThan(400);
  });
});
