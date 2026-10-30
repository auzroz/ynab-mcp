/**
 * OAuth-mode security properties over HTTP, through the SDK's real /register,
 * /authorize and /token handlers and the bearer middleware on /mcp:
 *  - the federation legs only run in the browser that saw the consent page
 *    (no consent bypass by sending a victim a /oauth/ynab/start link);
 *  - write access comes from the token's own grant, not the user's latest consent;
 *  - an MCP session can only be used by the client and user that created it.
 * Only the YNAB network calls are mocked; createServerForUser is spied on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>(
      '../../src/auth/ynab-oauth.js'
    );
  return {
    ...actual,
    exchangeCode: vi.fn(),
    getYnabUserId: vi.fn(),
    refreshAccessToken: vi.fn(),
  };
});

vi.mock('../../src/server.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/server.js')>('../../src/server.js');
  return { ...actual, createServerForUser: vi.fn(actual.createServerForUser) };
});

import { createHttpApp } from '../../src/http.js';
import * as ynabOauth from '../../src/auth/ynab-oauth.js';
import * as serverModule from '../../src/server.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { cookieHeaderFrom } from './helpers/consent-cookie.js';
import type { HttpConfig } from '../../src/config/environment.js';

const exchangeCodeMock = vi.mocked(ynabOauth.exchangeCode);
const getYnabUserIdMock = vi.mocked(ynabOauth.getYnabUserId);
const refreshAccessTokenMock = vi.mocked(ynabOauth.refreshAccessToken);
const createServerMock = vi.mocked(serverModule.createServerForUser);

const CALLBACK = 'https://client.example/cb';
const ATTACKER_CALLBACK = 'https://attacker.example/cb';

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

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

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

async function register(app: Express, redirectUri = CALLBACK): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [redirectUri], client_name: 'sec', token_endpoint_auth_method: 'none' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** GET /authorize: the consent page, its pending state and the consent cookie. */
async function consent(
  app: Express,
  clientId: string,
  redirectUri = CALLBACK
): Promise<{ state: string; cookie: string; res: request.Response }> {
  const res = await request(app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
  });
  expect(res.status).toBe(200);
  const m = /state=([^&"]+)&amp;scope=read-only/.exec(res.text);
  if (!m?.[1]) throw new Error('no consent link');
  return { state: decodeURIComponent(m[1]), cookie: cookieHeaderFrom(res), res };
}

/** Full, legitimate flow in one browser: returns the client id and its access token. */
async function connect(app: Express, choice: 'read-only' | 'read-write'): Promise<{ clientId: string; access: string }> {
  const clientId = await register(app);
  const { state, cookie } = await consent(app, clientId);
  const start = await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: choice });
  expect(start.status).toBe(302);
  const cb = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
  expect(cb.status).toBe(302);
  const code = new URL(cb.headers['location'] as string).searchParams.get('code');
  if (!code) throw new Error('no code');
  const tok = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
  });
  expect(tok.status).toBe(200);
  return { clientId, access: tok.body.access_token as string };
}

function mcp(app: Express, method: 'post' | 'get' | 'delete', access: string, sessionId?: string): request.Test {
  let req = request(app)[method]('/mcp')
    .set('Authorization', `Bearer ${access}`)
    .set('Accept', 'application/json, text/event-stream');
  if (sessionId !== undefined) req = req.set('mcp-session-id', sessionId);
  return req;
}

async function initSession(app: Express, access: string): Promise<string> {
  const res = await mcp(app, 'post', access).send(initializeBody);
  expect(res.status).toBe(200);
  const sid = res.headers['mcp-session-id'] as string | undefined;
  if (!sid) throw new Error('no session id');
  return sid;
}

const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

beforeEach(() => {
  vi.clearAllMocks();
  exchangeCodeMock.mockResolvedValue({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7200_000 });
  getYnabUserIdMock.mockResolvedValue('ynab-user-1');
  refreshAccessTokenMock.mockResolvedValue({ accessToken: 'ya2', refreshToken: 'yr2', expiresAt: Date.now() + 7200_000 });
});

describe('consent cannot be skipped (browser binding)', () => {
  it('the consent page sets a __Host- cookie and shows the redirect URI; it cannot be framed', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { res } = await consent(app, clientId);
    const set = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(set).toMatch(/^__Host-ynab_mcp_consent_[0-9a-f]{32}=[A-Za-z0-9_-]{43}; /);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Path=/');
    expect(res.text).toContain(CALLBACK);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it("a victim's browser following an attacker's /oauth/ynab/start link is refused", async () => {
    const app = await createHttpApp(makeConfig());
    // Attacker: registers a client with their own redirect URI and reads the state.
    const attackerClient = await register(app, ATTACKER_CALLBACK);
    const { state, cookie: attackerCookie } = await consent(app, attackerClient, ATTACKER_CALLBACK);

    // Victim: no cookie for that state.
    const victim = await request(app).get('/oauth/ynab/start').query({ state, scope: 'read-write' });
    expect(victim.status).toBe(400);
    expect(victim.headers['location']).toBeUndefined();
    expect(victim.text).toBe('Authorization request expired or invalid. Please start over.');

    // The state is now spent, even for the attacker's own browser.
    const replay = await request(app)
      .get('/oauth/ynab/start')
      .set('Cookie', attackerCookie)
      .query({ state, scope: 'read-write' });
    expect(replay.status).toBe(400);
  });

  it('a cookie for a different authorization does not satisfy this one', async () => {
    const app = await createHttpApp(makeConfig());
    const attacker = await consent(app, await register(app, ATTACKER_CALLBACK), ATTACKER_CALLBACK);
    const victim = await consent(app, await register(app));
    const res = await request(app)
      .get('/oauth/ynab/start')
      .set('Cookie', victim.cookie)
      .query({ state: attacker.state, scope: 'read-write' });
    expect(res.status).toBe(400);
  });

  it("a victim's YNAB callback for an attacker-started authorization is refused before any exchange", async () => {
    const app = await createHttpApp(makeConfig());
    const attackerClient = await register(app, ATTACKER_CALLBACK);
    const { state, cookie } = await consent(app, attackerClient, ATTACKER_CALLBACK);
    // Attacker runs start in their own browser and sends the YNAB URL to the victim.
    const start = await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: 'read-write' });
    expect(start.status).toBe(302);

    // YNAB sends the victim's browser (no consent cookie) back with a code.
    const cb = await request(app).get('/oauth/ynab/callback').query({ code: 'victim-ynab-code', state });
    expect(cb.status).toBe(400);
    expect(cb.headers['location']).toBeUndefined();
    expect(cb.text).not.toContain('victim-ynab-code');
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('a YNAB error callback or Cancel without the cookie is refused (no redirect)', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const a = await consent(app, clientId);
    const err = await request(app).get('/oauth/ynab/callback').query({ error: 'access_denied', state: a.state });
    expect(err.status).toBe(400);
    expect(err.headers['location']).toBeUndefined();

    const b = await consent(app, clientId);
    const cancel = await request(app).get('/oauth/cancel').query({ state: b.state });
    expect(cancel.status).toBe(400);
    expect(cancel.headers['location']).toBeUndefined();
  });

  it('the legitimate flow works and the callback clears the cookie', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { state, cookie } = await consent(app, clientId);
    await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: 'read-only' });
    const cb = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'c', state });
    expect(cb.status).toBe(302);
    expect(new URL(cb.headers['location'] as string).searchParams.get('code')).toBeTruthy();
    const cleared = (cb.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cleared.startsWith(`${cookie.split('=')[0]}=;`)).toBe(true);
    expect(cleared).toContain('Max-Age=0');
  });

  it('Cancel with the cookie clears it', async () => {
    const app = await createHttpApp(makeConfig());
    const { state, cookie } = await consent(app, await register(app));
    const res = await request(app).get('/oauth/cancel').set('Cookie', cookie).query({ state });
    expect(res.status).toBe(302);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
  });
});

describe('write access is per token grant', () => {
  function readOnlyOfLastSession(): boolean | undefined {
    return createServerMock.mock.calls.at(-1)?.[0].readOnly;
  }

  it("client A's read-only token stays read-only after the user connects client B read-write", async () => {
    const app = await createHttpApp(makeConfig());
    const a = await connect(app, 'read-only');
    const b = await connect(app, 'read-write');

    await initSession(app, a.access);
    expect(readOnlyOfLastSession()).toBe(true);
    await initSession(app, b.access);
    expect(readOnlyOfLastSession()).toBe(false);
  });

  it('a read-write grant is read-only when the user later reconnects YNAB read-only', async () => {
    const app = await createHttpApp(makeConfig());
    const b = await connect(app, 'read-write');
    await connect(app, 'read-only');
    await initSession(app, b.access);
    expect(readOnlyOfLastSession()).toBe(true);
  });

  it('YNAB_READ_ONLY=true overrides a read-write grant', async () => {
    const app = await createHttpApp(makeConfig({ readOnly: true }));
    const b = await connect(app, 'read-write');
    await initSession(app, b.access);
    expect(readOnlyOfLastSession()).toBe(true);
  });
});

describe('MCP sessions are bound to their creator', () => {
  it("another user's token cannot use, stream from, or delete a session", async () => {
    const app = await createHttpApp(makeConfig());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alice = await connect(app, 'read-only');
    getYnabUserIdMock.mockResolvedValue('ynab-user-2');
    const bob = await connect(app, 'read-only');
    const sid = await initSession(app, alice.access);

    const post = await mcp(app, 'post', bob.access, sid).send(toolsList);
    expect(post.status).toBe(400);
    expect(post.body.error.message).toBe('Bad Request: no valid session for this request');
    expect(JSON.stringify(post.body)).not.toContain('ynab_');

    const get = await mcp(app, 'get', bob.access, sid);
    expect(get.status).toBe(400);
    expect(get.body.error.message).toBe('Bad Request: unknown or missing session id');

    const del = await mcp(app, 'delete', bob.access, sid);
    expect(del.status).toBe(400);

    // Indistinguishable from an unknown session id.
    const unknown = await mcp(app, 'post', bob.access, 'no-such-session').send(toolsList);
    expect(unknown.status).toBe(post.status);
    expect(unknown.body).toEqual(post.body);

    // The owner's session survived the attempts.
    const own = await mcp(app, 'post', alice.access, sid).send(toolsList);
    expect(own.status).toBe(200);
    expect(own.text).toContain('ynab_');

    // Logged without identifiers.
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('[Session] rejected');
    expect(logged).not.toContain(sid);
    expect(logged).not.toContain(bob.access);
    errorSpy.mockRestore();
  });

  it("the same user's token from a different client cannot use the session", async () => {
    const app = await createHttpApp(makeConfig());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await connect(app, 'read-only');
    const second = await connect(app, 'read-only');
    expect(second.clientId).not.toBe(first.clientId);
    const sid = await initSession(app, first.access);
    const res = await mcp(app, 'post', second.access, sid).send(toolsList);
    expect(res.status).toBe(400);
    vi.mocked(console.error).mockRestore();
  });
});

describe('PUBLIC_URL as the OAuth issuer', () => {
  it('the SDK refuses an http [::1] issuer (why loadHttpConfig rejects it), but accepts localhost', async () => {
    await expect(
      createHttpApp(makeConfig({ publicUrl: 'http://[::1]:3000', resourceUrl: 'http://[::1]:3000/mcp' }))
    ).rejects.toThrow('Issuer URL must be HTTPS');
    await expect(
      createHttpApp(makeConfig({ publicUrl: 'http://localhost:3000', resourceUrl: 'http://localhost:3000/mcp' }))
    ).resolves.toBeDefined();
  });
});
