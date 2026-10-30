/**
 * The YNAB federation legs (/oauth/ynab/start, /oauth/ynab/callback,
 * /oauth/cancel) are rate-limited like the SDK's own OAuth endpoints.
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

const { exchangeCode } = vi.hoisted(() => ({
  exchangeCode: vi.fn(async () => ({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7200_000 })),
}));
vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode, getYnabUserId: vi.fn(async () => 'ynab-user-1') };
});

import { createHttpApp } from '../../src/http.js';
import { makeHttpConfig } from './helpers/http-config.js';

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
  it('answers 429 after 50 requests in the window, across all three legs', async () => {
    const app = await createHttpApp(config());
    const legs = ['/oauth/ynab/start', '/oauth/ynab/callback', '/oauth/cancel'];

    for (let i = 0; i < 50; i++) {
      const res = await request(app).get(legs[i % legs.length]!).query({ state: 'bogus', code: 'x' });
      expect(res.status, `request ${i + 1}`).toBe(400);
    }
    const limited = await request(app).get('/oauth/ynab/callback').query({ state: 'bogus', code: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.headers['ratelimit-policy'] ?? limited.headers['ratelimit']).toBeDefined();
    // A rejected request never reaches YNAB's token endpoint.
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('does not limit /mcp or the SDK-served endpoints through this limiter', async () => {
    const app = await createHttpApp(config());
    for (let i = 0; i < 51; i++) await request(app).get('/oauth/cancel').query({ state: 'bogus' });
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/.well-known/oauth-authorization-server')).status).toBe(200);
  });
});
