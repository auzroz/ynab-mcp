/**
 * #59: the AS limiters key by (client_id, IP) behind a proxy, /register by IP
 * and by redirect host, and the client address follows TRUST_PROXY and
 * TRUST_CF_CONNECTING_IP.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createHttpApp } from '../../src/http.js';
import {
  CLIENT_AUTH_ROUTE_RATE_LIMIT,
  AUTHORIZE_RATE_LIMIT,
} from '../../src/auth/as-router.js';
import { CEILING_FACTOR } from '../../src/middleware/rate-limiters.js';
import { makeHttpConfig } from './helpers/http-config.js';

const HOST = 'mcp.example.com';

const config = (overrides: Parameters<typeof makeHttpConfig>[0] = {}) =>
  makeHttpConfig({
    publicUrl: `https://${HOST}`,
    resourceUrl: `https://${HOST}/mcp`,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    allowedHosts: [HOST],
    enableDnsRebindingProtection: true,
    ...overrides,
  });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** POST /token for `clientId`, arriving from `xff` through a proxy. */
const token = (app: Express, clientId: string, headers: Record<string, string> = {}) =>
  request(app)
    .post('/token')
    .set('Host', HOST)
    .set(headers)
    .type('form')
    .send({ grant_type: 'authorization_code', client_id: clientId });

/** Fill `clientId`'s /token budget from `headers`; resolves when the next request would be limited. */
async function exhaustToken(app: Express, clientId: string, headers: Record<string, string>): Promise<void> {
  for (let i = 0; i < CLIENT_AUTH_ROUTE_RATE_LIMIT; i++) {
    const res = await token(app, clientId, headers);
    expect(res.status, `request ${i + 1}`).not.toBe(429);
  }
}

describe('keys behind a trusted proxy (TRUST_PROXY=1)', () => {
  it('gives two client IPs separate buckets, even for the same client_id', async () => {
    const { app } = { app: await createHttpApp(config({ trustProxy: 1 })) };
    await exhaustToken(app, 'shared', { 'X-Forwarded-For': '198.51.100.1' });
    expect((await token(app, 'shared', { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(429);
    // Another client address, same client_id: its own bucket.
    expect((await token(app, 'shared', { 'X-Forwarded-For': '198.51.100.2' })).status).not.toBe(429);
  });

  it('ignores an X-Forwarded-For entry beyond the hop count (a spoofed one)', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    // The proxy appends the real peer last; the client controls what comes before it.
    await exhaustToken(app, 'c', { 'X-Forwarded-For': '9.9.9.1, 198.51.100.1' });
    const spoofed = await token(app, 'c', { 'X-Forwarded-For': '9.9.9.2, 198.51.100.1' });
    expect(spoofed.status).toBe(429);
  });

  it('keys a different client_id from the same IP separately', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    await exhaustToken(app, 'one', { 'X-Forwarded-For': '198.51.100.1' });
    expect((await token(app, 'two', { 'X-Forwarded-For': '198.51.100.1' })).status).not.toBe(429);
  });

  it('caps one IP that rotates client_id with the IP-only ceiling', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const headers = { 'X-Forwarded-For': '198.51.100.1' };
    const budget = CLIENT_AUTH_ROUTE_RATE_LIMIT * CEILING_FACTOR;
    for (let i = 0; i < budget; i++) {
      const res = await token(app, `rot-${i}`, headers);
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    expect((await token(app, 'rot-next', headers)).status).toBe(429);
    // Another address is untouched.
    expect((await token(app, 'rot-next', { 'X-Forwarded-For': '198.51.100.2' })).status).not.toBe(429);
  });
});

describe('without a trusted proxy (TRUST_PROXY=0)', () => {
  it('ignores X-Forwarded-For: every request is the socket peer', async () => {
    const app = await createHttpApp(config({ trustProxy: 0 }));
    await exhaustToken(app, 'c', { 'X-Forwarded-For': '198.51.100.1' });
    expect((await token(app, 'c', { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(429);
  });
});

describe('CF-Connecting-IP', () => {
  it('is ignored by default', async () => {
    const app = await createHttpApp(config());
    await exhaustToken(app, 'c', { 'CF-Connecting-IP': '198.51.100.1' });
    expect((await token(app, 'c', { 'CF-Connecting-IP': '198.51.100.2' })).status).toBe(429);
  });

  it('keys the client with TRUST_CF_CONNECTING_IP=true, with no TRUST_PROXY', async () => {
    const app = await createHttpApp(config({ trustCfConnectingIp: true, trustProxy: 0 }));
    await exhaustToken(app, 'c', { 'CF-Connecting-IP': '198.51.100.1' });
    expect((await token(app, 'c', { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(429);
    expect((await token(app, 'c', { 'CF-Connecting-IP': '198.51.100.2' })).status).not.toBe(429);
  });

  it('puts a whole IPv6 /64 in one bucket', async () => {
    const app = await createHttpApp(config({ trustCfConnectingIp: true }));
    await exhaustToken(app, 'c', { 'CF-Connecting-IP': '2001:db8:1:2::1' });
    expect((await token(app, 'c', { 'CF-Connecting-IP': '2001:db8:1:2:ffff::9' })).status).toBe(429);
    expect((await token(app, 'c', { 'CF-Connecting-IP': '2001:db8:1:3::1' })).status).not.toBe(429);
  });
});

describe('/revoke and /authorize', () => {
  it('/revoke counts per (client_id, IP) in its own budget', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const revoke = (xff: string) =>
      request(app).post('/revoke').set('Host', HOST).set('X-Forwarded-For', xff).type('form').send({ token: 't', client_id: 'c' });
    for (let i = 0; i < CLIENT_AUTH_ROUTE_RATE_LIMIT; i++) await revoke('198.51.100.1');
    expect((await revoke('198.51.100.1')).status).toBe(429);
    expect((await revoke('198.51.100.2')).status).not.toBe(429);
  });

  it('/authorize is keyed from the query client_id and the IP, ahead of the parser', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const authorize = (xff: string, clientId: string) =>
      request(app).get('/authorize').set('Host', HOST).set('X-Forwarded-For', xff).query({ client_id: clientId });
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT; i++) await authorize('198.51.100.1', 'c');
    expect((await authorize('198.51.100.1', 'c')).status).toBe(429);
    expect((await authorize('198.51.100.2', 'c')).status).not.toBe(429);
    expect((await authorize('198.51.100.1', 'other')).status).not.toBe(429);
  });
});

describe('/register: per-IP limit and per-redirect-host limit', () => {
  const register = (app: Express, xff: string, redirect: string) =>
    request(app)
      .post('/register')
      .set('Host', HOST)
      .set('X-Forwarded-For', xff)
      .send({ client_name: 'x', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });

  it('limits one IP at REGISTER_RATE_LIMIT_PER_IP, above the SDK default of 20', async () => {
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerIp: 25, registerRateLimitPerHost: 1000 }));
    for (let i = 0; i < 25; i++) {
      const res = await register(app, '198.51.100.1', `https://h${i}.example/cb`);
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const limited = await register(app, '198.51.100.1', 'https://h99.example/cb');
    expect(limited.status).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe('*');
    expect((await register(app, '198.51.100.2', 'https://h99.example/cb')).status).not.toBe(429);
  });

  it('limits one redirect host across IPs', async () => {
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 3 }));
    for (let i = 0; i < 3; i++) {
      expect((await register(app, `198.51.100.${i + 1}`, 'https://claude.ai/cb')).status).not.toBe(429);
    }
    const limited = await register(app, '198.51.100.99', 'https://claude.ai/cb');
    expect(limited.status).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe('*');
    // Another host is untouched.
    expect((await register(app, '198.51.100.99', 'https://other.example/cb')).status).not.toBe(429);
  });

  it('counts every host a registration names', async () => {
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 2 }));
    const two = (xff: string) =>
      request(app)
        .post('/register')
        .set('Host', HOST)
        .set('X-Forwarded-For', xff)
        .send({ client_name: 'x', redirect_uris: ['https://spent.example/cb', 'https://fresh.example/cb'], token_endpoint_auth_method: 'none' });
    await register(app, '198.51.100.1', 'https://spent.example/cb');
    await register(app, '198.51.100.2', 'https://spent.example/cb');
    expect((await two('198.51.100.3')).status).toBe(429);
  });

  it('does not share one budget between native clients on loopback redirects', async () => {
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 2 }));
    for (let i = 0; i < 2; i++) await register(app, '198.51.100.1', 'http://127.0.0.1:5000/cb');
    expect((await register(app, '198.51.100.1', 'http://localhost:6000/cb')).status).toBe(429);
    expect((await register(app, '198.51.100.2', 'http://127.0.0.1:5000/cb')).status).not.toBe(429);
  });
});
