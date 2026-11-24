/**
 * The YNAB sign-in legs under /oauth (the library's interaction:
 * /oauth/interaction/:uid with /start, /complete and /cancel, and
 * /oauth/ynab/callback) are rate-limited like /authorize.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
  };
});

import { createHttpApp, OAUTH_LEG_RATE_LIMIT } from '../../src/http.js';
import { makeHttpConfig } from './helpers/http-config.js';

const LIMITED_TEXT = 'Too many authorization requests. Please wait and try again.';

/** An interaction uid of the library's shape that names no interaction. */
const UID = 'u'.repeat(43);
const CANCEL = `/oauth/interaction/${UID}/cancel`;

const config = () =>
  makeHttpConfig({
    publicUrl: 'https://mcp.example.com',
    resourceUrl: 'https://mcp.example.com/mcp',
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
  });

describe('OAuth federation legs rate limit', () => {
  it('keeps 0.4.x capacity of 50 sign-ins per IP: four leg requests each, 200 per 15 minutes', () => {
    expect(OAUTH_LEG_RATE_LIMIT).toBe(200);
  });

  it('answers 429 from the limiter after the limit, across every leg, without leaking input', async () => {
    const app = await createHttpApp(config());
    const legs = [`/oauth/interaction/${UID}`, `/oauth/interaction/${UID}/start`, '/oauth/ynab/callback', `/oauth/interaction/${UID}/complete`, CANCEL];
    // Distinctive values, so an echo of them in a response body is detectable.
    const state = 'state-SENTINEL-7f3a';
    const code = 'code-SENTINEL-91bc';
    const leaks = (text: string) =>
      [state, code, 'Error:', '    at ', 'node_modules', '/src/'].filter((s) => text.includes(s));

    for (let i = 0; i < OAUTH_LEG_RATE_LIMIT; i++) {
      const res = await request(app).get(legs[i % legs.length]!).query({ state, code });
      expect(res.status, `request ${i + 1}`).toBe(400);
      expect(res.text, `request ${i + 1}`).not.toBe(LIMITED_TEXT);
      expect(leaks(res.text), `request ${i + 1} body`).toEqual([]);
    }
    const limited = await request(app).get('/oauth/ynab/callback').query({ state, code });
    expect(limited.status).toBe(429);
    // The limiter answered, so the route handler (storage, YNAB) never ran.
    expect(limited.text).toBe(LIMITED_TEXT);
    expect(limited.headers['ratelimit-policy'] ?? limited.headers['ratelimit']).toBeDefined();
    expect(leaks(limited.text)).toEqual([]);
  });

  it('leaves /mcp, /health and the library endpoints alone once the legs are limited', async () => {
    const app = await createHttpApp(config());
    for (let i = 0; i < OAUTH_LEG_RATE_LIMIT; i++) await request(app).get(CANCEL).query({ state: 'bogus' });
    expect((await request(app).get(CANCEL).query({ state: 'bogus' })).status).toBe(429);

    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/.well-known/oauth-authorization-server')).status).toBe(200);
    // /mcp still reaches its bearer check (401), not this limiter.
    const mcp = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(mcp.status).toBe(401);
  });

  it('counts a request with a JSON body against the limit before parsing it', async () => {
    const app = await createHttpApp(config());
    for (let i = 0; i < OAUTH_LEG_RATE_LIMIT; i++) {
      await request(app).get(CANCEL).set('Content-Type', 'application/json').send('{not json');
    }
    // A malformed body would be a 400 parse error if parsing ran first; the
    // limiter answers before the body is read.
    const res = await request(app).get(CANCEL).set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(429);
    expect(res.text).toBe(LIMITED_TEXT);
  });

  it('is not mounted in header mode, which has no OAuth legs', async () => {
    const app = await createHttpApp(makeHttpConfig());
    for (let i = 0; i < OAUTH_LEG_RATE_LIMIT; i++) await request(app).get(CANCEL);
    expect((await request(app).get(CANCEL)).status).toBe(404);
  });
});
