/**
 * HTTP transport wiring: health, auth gate, and session validation.
 * (Full MCP protocol round-trips are exercised by integration tests later.)
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHttpApp } from '../../src/http.js';
import { makeHttpConfig } from './helpers/http-config.js';
import type { HttpConfig } from '../../src/config/environment.js';

const makeConfig = makeHttpConfig;

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
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.transport).toBe('http');
  });

  it('defaults to not trusting any reverse proxy hop', async () => {
    const app = await createHttpApp(makeConfig());
    expect(app.get('trust proxy')).toBe(0);
  });

  it('trusts the configured number of reverse-proxy hops', async () => {
    const app = await createHttpApp(makeConfig({ trustProxy: 1 }));
    expect(app.get('trust proxy')).toBe(1);
  });

  it('POST /mcp with a non-initialize request and no session → 400', async () => {
    const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(400);
  });

  it('POST /mcp initialize with no YNAB token → 401', async () => {
    const app = await createHttpApp(makeConfig({ fallbackAccessToken: undefined }));
    const res = await request(app).post('/mcp').send(initializeBody);
    expect(res.status).toBe(401);
  });

  it('GET /mcp without a session id → 400', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(400);
  });

  it('DELETE /mcp without a session id → 400', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).delete('/mcp');
    expect(res.status).toBe(400);
  });

  it('POST /mcp initialize with a token opens a session (returns Mcp-Session-Id)', async () => {
    const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);

    // A successful initialize issues a session id header regardless of body framing.
    expect(res.status).toBeLessThan(400);
    expect(res.headers['mcp-session-id']).toBeDefined();
  });

  it('DELETE /mcp with a valid session id tears the session down', async () => {
    const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
    const init = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toBeDefined();

    const del = await request(app).delete('/mcp').set('mcp-session-id', sessionId);
    expect(del.status).toBeLessThan(400);
  });

  describe('hardening', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];

    it('rejects JSON-RPC batch arrays without a session with -32600', async () => {
      const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
      const res = await request(app).post('/mcp').send(batch);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
      expect(res.body.jsonrpc).toBe('2.0');
    });

    it('rejects JSON-RPC batch arrays with a session id with -32600', async () => {
      const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
      const res = await request(app).post('/mcp').set('Mcp-Session-Id', 'some-session').send(batch);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
    });

    it('rejects a batch containing initialize', async () => {
      const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
      const res = await request(app).post('/mcp').send([initializeBody]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
    });

    it('returns a JSON-RPC 413 error for oversized bodies', async () => {
      const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
      const res = await request(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(600 * 1024) } });
      expect(res.status).toBe(413);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.error.code).toBe(-32600);
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(js|ts)|node_modules/);
    });

    it('returns a JSON-RPC -32700 error for malformed JSON', async () => {
      const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send('{"jsonrpc": "2.0", bad');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: invalid JSON' },
        id: null,
      });
    });

    it('accepts a realistic 100-transaction create_transactions payload', async () => {
      const app = await createHttpApp(makeConfig({ fallbackAccessToken: 'env-token' }));
      const transactions = Array.from({ length: 100 }, (_, i) => ({
        account_id: '123e4567-e89b-12d3-a456-426614174000',
        date: '2025-01-15',
        amount: -12345 - i,
        payee_name: `Payee number ${i} with a fairly long descriptive name`,
        category_id: '123e4567-e89b-12d3-a456-426614174001',
        memo: 'm'.repeat(500),
        cleared: 'uncleared',
        import_id: `YNAB:${-12345 - i}:2025-01-15:${i}`,
      }));
      const body = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ynab_create_transactions', arguments: { transactions } },
      };
      const size = Buffer.byteLength(JSON.stringify(body));
      expect(size).toBeLessThan(512 * 1024);
      // Not an initialize request and no session: passes the body parser and is
      // rejected by session validation (400 -32000), not by the size limit.
      const res = await request(app).post('/mcp').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32000);
    });
  });
});
