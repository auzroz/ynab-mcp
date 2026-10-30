/**
 * Host / Origin validation: unit behavior of the normalizers and middleware, and
 * its wiring in the HTTP app (header and oauth mode).
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  deriveOriginsFromHosts,
  hostValidation,
  normalizeHost,
  normalizeOrigin,
  originValidation,
} from '../../../src/middleware/origin-validation.js';
import { createHttpApp } from '../../../src/http.js';
import { makeHttpConfig } from '../helpers/http-config.js';

describe('normalizeHost', () => {
  it('lowercases and drops default ports', () => {
    expect(normalizeHost('MCP.Example.COM')).toBe('mcp.example.com');
    expect(normalizeHost('mcp.example.com:443')).toBe('mcp.example.com');
    expect(normalizeHost('mcp.example.com:80')).toBe('mcp.example.com');
    expect(normalizeHost('mcp.example.com:8443')).toBe('mcp.example.com:8443');
    expect(normalizeHost('mcp.example.com.')).toBe('mcp.example.com');
  });
  it('handles IPv6 literals', () => {
    expect(normalizeHost('[::1]')).toBe('[::1]');
    expect(normalizeHost('[::1]:3000')).toBe('[::1]:3000');
    expect(normalizeHost('[0:0:0:0:0:0:0:1]:3000')).toBe('[::1]:3000');
  });
  it('rejects malformed hosts', () => {
    for (const bad of ['', 'a b', 'evil.com/x', 'user@evil.com', 'http://evil.com', 'a:b', 'a:123456', '::1']) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
    expect(normalizeHost(undefined)).toBeNull();
  });
});

describe('normalizeOrigin', () => {
  it('canonicalizes case and default ports', () => {
    expect(normalizeOrigin('HTTPS://MCP.Example.com')).toBe('https://mcp.example.com');
    expect(normalizeOrigin('https://mcp.example.com:443')).toBe('https://mcp.example.com');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
  });
  it('rejects non-origins', () => {
    for (const bad of ['null', '', 'file:///x', 'https://u:p@a.com', 'https://a.com/path', 'https://a.com?x=1', 'a.com', 'https://a.com, https://b.com']) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });
});

describe('deriveOriginsFromHosts', () => {
  it('uses https, plus http for loopback', () => {
    expect(deriveOriginsFromHosts(['mcp.example.com', 'localhost:3000', 'junk path'])).toEqual([
      'https://mcp.example.com',
      'https://localhost:3000',
      'http://localhost:3000',
    ]);
  });
});

describe('middleware construction', () => {
  it('fails fast on malformed allow-list entries', () => {
    expect(() => hostValidation(['https://mcp.example.com'])).toThrow(/ALLOWED_HOSTS/);
    expect(() => originValidation(['mcp.example.com'])).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe('hostValidation / originValidation (standalone)', () => {
  const app = express();
  app.use(hostValidation(['mcp.example.com', '[::1]:3000'], { skipPaths: ['/health'] }));
  app.use('/mcp', originValidation(['https://mcp.example.com', 'http://[::1]:3000']));
  app.all(/.*/, (_req, res) => {
    res.json({ ok: true });
  });

  it('allows an allowed Host without Origin', async () => {
    expect((await request(app).get('/mcp').set('Host', 'mcp.example.com')).status).toBe(200);
  });
  it('is case-insensitive on Host and tolerates the default port', async () => {
    expect((await request(app).get('/mcp').set('Host', 'MCP.EXAMPLE.COM:443')).status).toBe(200);
  });
  it('rejects a foreign Host with a generic JSON-RPC error', async () => {
    const res = await request(app).get('/mcp').set('Host', 'evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden: invalid Host header' }, id: null });
  });
  it('rejects a port the list does not name', async () => {
    expect((await request(app).get('/mcp').set('Host', 'mcp.example.com:8443')).status).toBe(403);
  });
  it('accepts IPv6 Host and Origin', async () => {
    const res = await request(app).get('/mcp').set('Host', '[0:0:0:0:0:0:0:1]:3000').set('Origin', 'http://[::1]:3000');
    expect(res.status).toBe(200);
  });
  it('allows an allowed Origin, including case and default port variants', async () => {
    for (const o of ['https://mcp.example.com', 'HTTPS://MCP.example.com:443']) {
      expect((await request(app).get('/mcp').set('Host', 'mcp.example.com').set('Origin', o)).status, o).toBe(200);
    }
  });
  it('rejects foreign, scheme-mismatched, port-mismatched and null Origins', async () => {
    for (const o of ['https://evil.example', 'http://mcp.example.com', 'https://mcp.example.com:8443', 'null', 'https://mcp.example.com.evil.example']) {
      const res = await request(app).get('/mcp').set('Host', 'mcp.example.com').set('Origin', o);
      expect(res.status, o).toBe(403);
      expect(res.body.error.message).toBe('Forbidden: invalid Origin header');
    }
  });
  it('does not apply the Origin check outside its mount, and skips Host for /health', async () => {
    expect((await request(app).get('/other').set('Host', 'mcp.example.com').set('Origin', 'https://evil.example')).status).toBe(200);
    expect((await request(app).get('/health').set('Host', '10.0.0.5')).status).toBe(200);
  });
});

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

describe('HTTP app wiring (header mode)', () => {
  const base = { fallbackAccessToken: 'tok', enableDnsRebindingProtection: true };

  it('loopback defaults: localhost Host and Origin pass, foreign ones do not', async () => {
    const app = await createHttpApp(
      makeHttpConfig({ ...base, allowedHosts: ['localhost', 'localhost:3000', '127.0.0.1', '[::1]'], allowedOrigins: undefined })
    );
    const ok = await request(app)
      .post('/mcp')
      .set('Host', 'localhost:3000')
      .set('Origin', 'http://localhost:3000')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(ok.status).toBeLessThan(400);
    const bad = await request(app).post('/mcp').set('Host', 'localhost:3000').set('Origin', 'https://evil.example').send(initializeBody);
    expect(bad.status).toBe(403);
    const badHost = await request(app).post('/mcp').set('Host', 'rebind.evil.example:3000').send(initializeBody);
    expect(badHost.status).toBe(403);
  });

  it('allows requests without Origin (non-browser clients)', async () => {
    const app = await createHttpApp(makeHttpConfig({ ...base, allowedHosts: ['mcp.example.com'], allowedOrigins: ['https://mcp.example.com'] }));
    const res = await request(app)
      .post('/mcp')
      .set('Host', 'mcp.example.com')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.status).toBeLessThan(400);
    expect(res.headers['mcp-session-id']).toBeDefined();
  });

  it('is checked before body parsing and session lookup', async () => {
    const app = await createHttpApp(makeHttpConfig({ ...base, allowedHosts: ['mcp.example.com'], allowedOrigins: [] }));
    const res = await request(app).delete('/mcp').set('Host', 'evil.example').set('mcp-session-id', 'x');
    expect(res.status).toBe(403);
  });

  it('opt-out (protection disabled) accepts any Host and Origin', async () => {
    const app = await createHttpApp(
      makeHttpConfig({ ...base, enableDnsRebindingProtection: false, allowedHosts: ['mcp.example.com'], allowedOrigins: ['https://mcp.example.com'] })
    );
    const res = await request(app)
      .post('/mcp')
      .set('Host', 'evil.example')
      .set('Origin', 'https://evil.example')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.status).toBeLessThan(400);
  });

  it('/health is reachable by pod IP', async () => {
    const app = await createHttpApp(makeHttpConfig({ ...base, allowedHosts: ['mcp.example.com'] }));
    expect((await request(app).get('/health').set('Host', '10.1.2.3:3000')).status).toBe(200);
  });
});

describe('HTTP app wiring (oauth mode)', () => {
  const config = () =>
    makeHttpConfig({
      publicUrl: 'https://mcp.example.com',
      resourceUrl: 'https://mcp.example.com/mcp',
      authMode: 'oauth',
      oauthClientId: 'cid',
      oauthClientSecret: 'sec',
      encryptionKey: randomBytes(32).toString('base64'),
      enableDnsRebindingProtection: true,
      allowedHosts: ['mcp.example.com'],
      allowedOrigins: ['https://mcp.example.com'],
    });
  const wellKnown = [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
  ];

  it('well-known metadata stays CORS-readable from any Origin', async () => {
    const app = await createHttpApp(config());
    for (const path of wellKnown) {
      const res = await request(app).get(path).set('Host', 'mcp.example.com').set('Origin', 'https://app.client.example');
      expect(res.status, path).toBe(200);
      expect(res.headers['access-control-allow-origin'], path).toBe('*');
    }
  });

  it('DCR and token endpoints are not Origin-restricted (browser-based clients), but Host is enforced', async () => {
    const app = await createHttpApp(config());
    const reg = await request(app)
      .post('/register')
      .set('Host', 'mcp.example.com')
      .set('Origin', 'https://app.client.example')
      .send({ redirect_uris: ['https://app.client.example/cb'], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
    const wrongHost = await request(app).get(wellKnown[0]!).set('Host', 'evil.example');
    expect(wrongHost.status).toBe(403);
    const wrongHostReg = await request(app).post('/register').set('Host', 'evil.example').send({ redirect_uris: ['https://x.example/cb'] });
    expect(wrongHostReg.status).toBe(403);
  });

  it('/mcp rejects a foreign Origin before authentication (403, not 401)', async () => {
    const app = await createHttpApp(config());
    const res = await request(app).post('/mcp').set('Host', 'mcp.example.com').set('Origin', 'https://evil.example').send(initializeBody);
    expect(res.status).toBe(403);
    const noOrigin = await request(app).post('/mcp').set('Host', 'mcp.example.com').send(initializeBody);
    expect(noOrigin.status).toBe(401);
  });
});
