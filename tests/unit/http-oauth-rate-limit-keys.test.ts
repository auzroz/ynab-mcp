/**
 * #59: the AS limiters key by (client_id, IP) behind a proxy, /register by IP
 * and by redirect host, and the client address follows TRUST_PROXY and
 * TRUST_CF_CONNECTING_IP. #55: a verified redirect host is keyed by host and
 * IP, and a registration the DCR validator refuses spends no host's budget.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';
import type { Store } from 'express-rate-limit';
import { createHttpApp } from '../../src/http.js';
import {
  CLIENT_AUTH_ROUTE_RATE_LIMIT,
  AUTHORIZE_RATE_LIMIT,
  OAUTH_LEG_RATE_LIMIT,
  mountAuthorizationServer,
} from '../../src/auth/as-router.js';
import { CEILING_FACTOR, type LimiterStoreFactory } from '../../src/middleware/rate-limiters.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { Encryptor } from '../../src/crypto.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER } from './helpers/token-hasher.js';

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

  it('/authorize is keyed from the query client_id and the IP', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const authorize = (xff: string, clientId: string, headers: Record<string, string> = {}) =>
      request(app).get('/authorize').set('Host', HOST).set('X-Forwarded-For', xff).set(headers).query({ client_id: clientId });
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT; i++) await authorize('198.51.100.1', 'c');
    expect((await authorize('198.51.100.1', 'c')).status).toBe(429);
    expect((await authorize('198.51.100.2', 'c')).status).not.toBe(429);
    expect((await authorize('198.51.100.1', 'other')).status).not.toBe(429);
    // Rotating a Basic user does not make a new bucket for the same client_id.
    const basic = `Basic ${Buffer.from('rotated:x').toString('base64')}`;
    expect((await authorize('198.51.100.1', 'c', { Authorization: basic })).status).toBe(429);
  });

  it('/authorize POST is keyed by its form body client_id', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const post = (clientId: string) =>
      request(app).post('/authorize').set('Host', HOST).set('X-Forwarded-For', '198.51.100.1').type('form').send({ client_id: clientId });
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT; i++) await post('c');
    expect((await post('c')).status).toBe(429);
    expect((await post('other')).status).not.toBe(429);
  });

  it('/authorize has an IP-only guard ahead of the parser at ten times the budget', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const headers = { 'X-Forwarded-For': '198.51.100.1' };
    for (let i = 0; i < AUTHORIZE_RATE_LIMIT * CEILING_FACTOR; i++) {
      await request(app).get('/authorize').set('Host', HOST).set(headers).query({ client_id: `rot-${i}` });
    }
    expect((await request(app).get('/authorize').set('Host', HOST).set(headers).query({ client_id: 'rot-next' })).status).toBe(429);
  });

  it('/token ignores a rotating Basic user: the body client_id picks the bucket', async () => {
    const app = await createHttpApp(config({ trustProxy: 1 }));
    const send = (i: number) =>
      request(app)
        .post('/token')
        .set('Host', HOST)
        .set('X-Forwarded-For', '198.51.100.1')
        .set('Authorization', `Basic ${Buffer.from(`rot-${i}:x`).toString('base64')}`)
        .type('form')
        .send({ grant_type: 'authorization_code', client_id: 'fixed' });
    for (let i = 0; i < CLIENT_AUTH_ROUTE_RATE_LIMIT; i++) await send(i);
    expect((await send(999)).status).toBe(429);
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

  it('refuses a registration with too many redirect URIs, and counts none of them', async () => {
    // The DCR validator's bound (5) refuses it, before any host is counted.
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 1 }));
    const uris = [...Array.from({ length: 11 }, (_, i) => `https://pad${i}.example/cb`), 'https://target.example/cb'];
    const res = await request(app).post('/register').set('Host', HOST).set('X-Forwarded-For', '198.51.100.1').send({ redirect_uris: uris });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
    // The target host's budget is untouched.
    expect((await register(app, '198.51.100.2', 'https://target.example/cb')).status).not.toBe(429);
  });

  it('limits one unverified redirect host across IPs', async () => {
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 3 }));
    for (let i = 0; i < 3; i++) {
      expect((await register(app, `198.51.100.${i + 1}`, 'https://shared.example/cb')).status).not.toBe(429);
    }
    const limited = await register(app, '198.51.100.99', 'https://shared.example/cb');
    expect(limited.status).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe('*');
    // Another host is untouched.
    expect((await register(app, '198.51.100.99', 'https://other.example/cb')).status).not.toBe(429);
  });

  it('keys a verified redirect host by host and IP, so one IP spending it does not lock out another (#55)', async () => {
    // claude.ai is on the default MCP_VERIFIED_REDIRECT_URIS.
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 3 }));
    const callback = 'https://claude.ai/api/mcp/auth_callback';
    for (let i = 0; i < 3; i++) {
      expect((await register(app, '198.51.100.1', callback)).status, `request ${i + 1}`).toBe(201);
    }
    const limited = await register(app, '198.51.100.1', callback);
    expect(limited.status).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe('*');
    // Any path on the host is the same bucket for that IP.
    expect((await register(app, '198.51.100.1', 'https://claude.ai/other')).status).toBe(429);
    // Another IP has its own budget for the host.
    for (let i = 0; i < 3; i++) {
      expect((await register(app, '198.51.100.2', callback)).status, `other IP, request ${i + 1}`).toBe(201);
    }
    expect((await register(app, '198.51.100.2', callback)).status).toBe(429);
  });

  it('takes the verified hosts from MCP_VERIFIED_REDIRECT_URIS', async () => {
    const app = await createHttpApp(
      config({ trustProxy: 1, registerRateLimitPerHost: 1, verifiedRedirectUris: ['https://app.example/cb'] })
    );
    // claude.ai is not verified here: shared across IPs.
    expect((await register(app, '198.51.100.1', 'https://claude.ai/cb')).status).toBe(201);
    expect((await register(app, '198.51.100.2', 'https://claude.ai/cb')).status).toBe(429);
    // app.example is: one budget per IP.
    expect((await register(app, '198.51.100.1', 'https://app.example/cb')).status).toBe(201);
    expect((await register(app, '198.51.100.2', 'https://app.example/cb')).status).toBe(201);
    expect((await register(app, '198.51.100.2', 'https://app.example/cb')).status).toBe(429);
  });

  it('spends no redirect host budget on a registration the DCR validator refuses', async () => {
    const app = await createHttpApp(config({ trustProxy: 1, registerRateLimitPerHost: 1 }));
    const target = 'https://target.example/cb';
    const invalid = [
      { client_name: 'bell\u0007', redirect_uris: [target] },
      { client_name: 'x', redirect_uris: [target, 'http://plain.example/cb'] },
      { client_name: 'x', redirect_uris: [target], token_endpoint_auth_method: 'has space' },
    ];
    for (const body of invalid) {
      const res = await request(app).post('/register').set('Host', HOST).set('X-Forwarded-For', '198.51.100.1').send(body);
      expect(res.status).toBe(400);
      expect(['invalid_client_metadata', 'invalid_redirect_uri']).toContain(res.body.error);
    }
    // The host's single registration is still there for a valid one...
    expect((await register(app, '198.51.100.2', target)).status).toBe(201);
    // ...and that one did spend it.
    expect((await register(app, '198.51.100.3', target)).status).toBe(429);
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

describe('every AS limiter keys by the client address, through the injected store', () => {
  /** A store factory that records, per limiter name, the keys it was asked to count. */
  function recordingStores(): { factory: LimiterStoreFactory; keys: Map<string, string[]> } {
    const keys = new Map<string, string[]>();
    const factory: LimiterStoreFactory = (name) => {
      keys.set(name, []);
      const hits = new Map<string, number>();
      const store: Store = {
        async increment(key) {
          keys.get(name)!.push(key);
          hits.set(key, (hits.get(key) ?? 0) + 1);
          return { totalHits: hits.get(key)!, resetTime: new Date(Date.now() + 60_000) };
        },
        async decrement() {},
        async resetKey() {},
      };
      return store;
    };
    return { factory, keys };
  }

  /** The AS alone on an app, as http.ts mounts it (trust proxy set first). */
  function mountWith(overrides: Parameters<typeof config>[0], limiterStore: LimiterStoreFactory): Express {
    const cfg = config(overrides);
    const app = express();
    app.set('trust proxy', cfg.trustProxy);
    mountAuthorizationServer(app, {
      config: cfg,
      storage: new MemoryStorage(),
      encryptor: new Encryptor(randomBytes(32).toString('base64')),
      tokenHasher: TEST_TOKEN_HASHER,
      ynab: { clientId: 'cid', clientSecret: 'sec' },
      limiterStore,
    });
    return app;
  }

  /** One request per AS route, each reaching every limiter on its route. */
  const PER_ROUTE: ReadonlyArray<(app: Express) => request.Test> = [
    (app) => request(app).get('/authorize').query({ client_id: 'c' }),
    (app) => request(app).post('/token').type('form').send({ grant_type: 'authorization_code', client_id: 'c' }),
    (app) => request(app).post('/revoke').type('form').send({ token: 't', client_id: 'c' }),
    // A verified host, so register:host keys by host and address too.
    (app) => request(app).post('/register').send({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    (app) => request(app).get('/oauth/cancel'),
  ];

  it.each([
    { setup: 'TRUST_PROXY=1, X-Forwarded-For', overrides: { trustProxy: 1 }, header: 'X-Forwarded-For' },
    // req.ip is the socket peer for every request here: only clientKey tells them apart.
    {
      setup: 'TRUST_CF_CONNECTING_IP=true, CF-Connecting-IP',
      overrides: { trustProxy: 0, trustCfConnectingIp: true },
      header: 'CF-Connecting-IP',
    },
  ])('$setup: every limiter counts each address in its own bucket', async ({ overrides, header }) => {
    const { factory, keys } = recordingStores();
    const app = mountWith(overrides, factory);
    for (const ip of ['198.51.100.1', '198.51.100.2']) {
      for (const send of PER_ROUTE) await send(app).set(header, ip);
    }
    expect([...keys.keys()].sort()).toEqual(
      [
        'oauth-leg',
        'route:token:ip',
        'route:token:client',
        'authorize:ip',
        'authorize:client',
        'route:token revocation:ip',
        'route:token revocation:client',
        'register:ip',
        'register:host',
      ].sort()
    );
    for (const [name, counted] of keys) {
      // Each limiter saw both addresses, under different keys that name them.
      expect(counted, name).toHaveLength(2);
      expect(counted[0], name).toMatch(/ip:198\.51\.100\.1$/);
      expect(counted[1], name).toMatch(/ip:198\.51\.100\.2$/);
    }
    expect(keys.get('register:host')).toEqual(['verified:claude.ai|ip:198.51.100.1', 'verified:claude.ai|ip:198.51.100.2']);
    expect(keys.get('route:token:client')).toEqual(['client:c|ip:198.51.100.1', 'client:c|ip:198.51.100.2']);
  });
});
