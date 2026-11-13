/**
 * OAuth-mode security properties over HTTP, through the SDK's real /register,
 * /authorize and /token handlers and the bearer middleware on /mcp:
 *  - the federation legs only run in the browser that saw the consent page
 *    (no consent bypass by sending a victim a /oauth/ynab/start link);
 *  - write access comes from the token's own grant, not the user's latest consent;
 *  - /mcp is stateless (ADR-0001): each request is served as the client and
 *    user its own token names, at its own token's access level;
 *  - each request resolves the user's YNAB token (refreshed tokens are used;
 *    a lost grant refuses the request, or fails a call with a generic error).
 * Only the YNAB network calls are mocked; createServerForRequest is spied on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  return { ...actual, createServerForRequest: vi.fn(actual.createServerForRequest) };
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
const createServerMock = vi.mocked(serverModule.createServerForRequest);

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
  redirectUri = CALLBACK,
  scope?: string
): Promise<{ state: string; cookie: string; res: request.Response }> {
  const res = await request(app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    ...(scope !== undefined ? { scope } : {}),
  });
  expect(res.status).toBe(200);
  const m = /state=([^&"]+)&amp;scope=read-only/.exec(res.text);
  if (!m?.[1]) throw new Error('no consent link');
  return { state: decodeURIComponent(m[1]), cookie: cookieHeaderFrom(res), res };
}

/** Full, legitimate flow in one browser: returns the client id and its access and refresh tokens. */
async function connect(
  app: Express,
  choice: 'read-only' | 'read-write',
  scope?: string
): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId = await register(app);
  const { state, cookie } = await consent(app, clientId, CALLBACK, scope);
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
  return { clientId, access: tok.body.access_token as string, refresh: tok.body.refresh_token as string };
}

/** POST /token with a refresh token (and an optional narrower scope). */
async function refresh(
  app: Express,
  clientId: string,
  refreshToken: string,
  scope?: string
): Promise<{ access: string; refresh: string; scope: string }> {
  const tok = await request(app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      ...(scope !== undefined ? { scope } : {}),
    });
  expect(tok.status).toBe(200);
  return {
    access: tok.body.access_token as string,
    refresh: tok.body.refresh_token as string,
    scope: tok.body.scope as string,
  };
}

function mcp(app: Express, method: 'post' | 'get' | 'delete', access: string, sessionId?: string): request.Test {
  let req = request(app)[method]('/mcp')
    .set('Authorization', `Bearer ${access}`)
    .set('Accept', 'application/json, text/event-stream');
  if (sessionId !== undefined) req = req.set('mcp-session-id', sessionId);
  return req;
}

/** An initialize, which a stateless server answers with no session id. */
async function initialize(app: Express, access: string): Promise<void> {
  const res = await mcp(app, 'post', access).send(initializeBody);
  expect(res.status).toBe(200);
  expect(res.headers['mcp-session-id']).toBeUndefined();
}

/** The context the last request's server was built from. */
function lastContext(): serverModule.RequestContext {
  const ctx = createServerMock.mock.calls.at(-1)?.[0];
  if (!ctx) throw new Error('no server built');
  return ctx;
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
  function readOnlyOfLastRequest(): boolean {
    return lastContext().user.readOnly;
  }

  it("client A's read-only token stays read-only after the user connects client B read-write", async () => {
    const app = await createHttpApp(makeConfig());
    const a = await connect(app, 'read-only');
    const b = await connect(app, 'read-write');

    await initialize(app, a.access);
    expect(readOnlyOfLastRequest()).toBe(true);
    await initialize(app, b.access);
    expect(readOnlyOfLastRequest()).toBe(false);
    // And A's next request is still read-only.
    await mcp(app, 'post', a.access).send(toolsList);
    expect(readOnlyOfLastRequest()).toBe(true);
  });

  it('a read-write grant is read-only when the user later reconnects YNAB read-only', async () => {
    const app = await createHttpApp(makeConfig());
    const b = await connect(app, 'read-write');
    await initialize(app, b.access);
    expect(readOnlyOfLastRequest()).toBe(false);
    // The same token's next request after the read-only reconnect is read-only (D4).
    await connect(app, 'read-only');
    await mcp(app, 'post', b.access).send(toolsList);
    expect(readOnlyOfLastRequest()).toBe(true);
  });

  it('YNAB_READ_ONLY=true overrides a read-write grant', async () => {
    const app = await createHttpApp(makeConfig({ readOnly: true }));
    const b = await connect(app, 'read-write');
    await initialize(app, b.access);
    expect(readOnlyOfLastRequest()).toBe(true);
  });
});

describe('each request is served as the client and user of its own token', () => {
  it("another user's token is served as that user, whatever session id it sends", async () => {
    const app = await createHttpApp(makeConfig());
    const alice = await connect(app, 'read-only');
    getYnabUserIdMock.mockResolvedValue('ynab-user-2');
    const bob = await connect(app, 'read-only');
    await initialize(app, alice.access);
    const aliceCtx = lastContext();

    // A session id from before 0.5 (or anyone's) means nothing: Bob is Bob.
    const post = await mcp(app, 'post', bob.access, 'alices-old-session-id').send(toolsList);
    expect(post.status).toBe(200);
    const bobCtx = lastContext();
    expect(bobCtx.userKey).toBe('ynab-user-2');
    expect(aliceCtx.userKey).toBe('ynab-user-1');
    expect(bobCtx.components.auditLog).not.toBe(aliceCtx.components.auditLog);
    expect(bobCtx.components.rateLimiter).not.toBe(aliceCtx.components.rateLimiter);

    // There is no session to stream from or delete.
    expect((await mcp(app, 'get', bob.access, 'alices-old-session-id')).status).toBe(405);
    expect((await mcp(app, 'delete', bob.access, 'alices-old-session-id')).status).toBe(405);
  });

  it("the same user's token from a different client is served as that client", async () => {
    const app = await createHttpApp(makeConfig());
    const first = await connect(app, 'read-only');
    const second = await connect(app, 'read-only');
    expect(second.clientId).not.toBe(first.clientId);
    await initialize(app, first.access);
    const firstCtx = lastContext();
    const res = await mcp(app, 'post', second.access).send(toolsList);
    expect(res.status).toBe(200);
    const secondCtx = lastContext();
    // Caps key on (client, user); the user's YNAB state is shared.
    expect(firstCtx.clientId).toBe(first.clientId);
    expect(secondCtx.clientId).toBe(second.clientId);
    expect(secondCtx.userKey).toBe(firstCtx.userKey);
  });
});

describe('each request has its own token\'s access level', () => {
  it('a read-only token of the same client and user is read-only, before and after a read-write one', async () => {
    const app = await createHttpApp(makeConfig());
    const rw = await connect(app, 'read-write', 'read-write');
    await initialize(app, rw.access);
    expect(lastContext().user.readOnly).toBe(false);

    // Same client, same user, narrower token.
    const ro = await refresh(app, rw.clientId, rw.refresh, 'read-only');
    expect(ro.scope).toBe('read-only');
    const post = await mcp(app, 'post', ro.access).send(toolsList);
    expect(post.status).toBe(200);
    expect(lastContext().user.readOnly).toBe(true);
    expect(post.text).not.toContain('"name":"ynab_create_transaction"');

    // A read-write token from a later, same-level refresh is read-write again.
    const rw2 = await refresh(app, rw.clientId, ro.refresh);
    expect(rw2.scope).toBe('read-write');
    const own = await mcp(app, 'post', rw2.access).send(toolsList);
    expect(own.status).toBe(200);
    expect(own.text).toContain('"name":"ynab_create_transaction"');
    expect(lastContext().user.readOnly).toBe(false);
  });

  it('a token downscoped on refresh is read-only on its next request and refuses writes', async () => {
    const app = await createHttpApp(makeConfig());
    const rw = await connect(app, 'read-write', 'read-write');
    const ro = await refresh(app, rw.clientId, rw.refresh, 'read-only');
    await initialize(app, ro.access);
    expect(lastContext().user.readOnly).toBe(true);

    const call = await mcp(app, 'post', ro.access).send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ynab_delete_transaction',
        arguments: { budget_id: 'last-used', transaction_id: '00000000-0000-4000-8000-000000000000' },
      },
    });
    expect(call.status).toBe(200);
    expect(call.text).toContain('read_only_mode');
  });
});

describe('per-user state is keyed by YNAB user', () => {
  it("one user's requests from two clients share a rate limiter; another user's do not", async () => {
    const app = await createHttpApp(makeConfig());
    const first = await connect(app, 'read-only');
    const second = await connect(app, 'read-only');
    getYnabUserIdMock.mockResolvedValue('ynab-user-2');
    const bob = await connect(app, 'read-only');

    await initialize(app, first.access);
    const a = lastContext().components;
    await initialize(app, second.access);
    const b = lastContext().components;
    await initialize(app, bob.access);
    const c = lastContext().components;

    expect(a?.rateLimiter).toBeDefined();
    expect(b?.rateLimiter).toBe(a?.rateLimiter);
    expect(b?.auditLog).toBe(a?.auditLog);
    expect(c?.rateLimiter).not.toBe(a?.rateLimiter);
    expect(c?.cache).not.toBe(a?.cache);
    expect(c?.auditLog).not.toBe(a?.auditLog);
  });
});

describe('the YNAB token is resolved per request', () => {
  // Every refresh returns a token inside the resolver's refresh skew, so each
  // resolve refreshes again and the token in use is observable per call.
  function rotateOnEveryResolve(): void {
    let n = 0;
    refreshAccessTokenMock.mockImplementation(async () => {
      n++;
      return { accessToken: `ya-${n}`, refreshToken: `yr-${n}`, expiresAt: Date.now() + 30_000 };
    });
  }

  const getUserCall = (id: number): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'ynab_get_user', arguments: {} },
  });

  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { user: { id: 'ynab-user-1' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the current (refreshed) YNAB token on each call, not the one from initialize', async () => {
    const app = await createHttpApp(makeConfig());
    const alice = await connect(app, 'read-only');
    rotateOnEveryResolve();
    await initialize(app, alice.access); // the request stage resolves ya-1

    // Each request resolves the grant before its server is built (ya-2, ya-4),
    // and the call resolves the token it sends to YNAB (ya-3, ya-5).
    expect((await mcp(app, 'post', alice.access).send(getUserCall(3))).status).toBe(200);
    expect((await mcp(app, 'post', alice.access).send(getUserCall(4))).status).toBe(200);

    const bearers = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
    expect(bearers).toEqual(['Bearer ya-3', 'Bearer ya-5']);
  });

  it('fails tool calls with a generic auth error once YNAB refuses the refresh', async () => {
    const app = await createHttpApp(makeConfig());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alice = await connect(app, 'read-only');
    rotateOnEveryResolve();
    await initialize(app, alice.access);
    // The request stage's resolve still gets a token; then the user revokes
    // the app at YNAB and the call's own refresh is refused.
    refreshAccessTokenMock
      .mockImplementationOnce(async () => ({ accessToken: 'ya-x', refreshToken: 'yr-x', expiresAt: Date.now() + 30_000 }))
      .mockRejectedValue(new Error('YNAB token request failed with status 400 (invalid_grant)'));

    const call = await mcp(app, 'post', alice.access).send(getUserCall(3));
    expect(call.status).toBe(200);
    expect(call.text).toContain('auth_error');
    expect(call.text).toContain('Could not get YNAB authorization for this request');
    expect(call.text).not.toContain('invalid_grant');
    expect(call.text).not.toContain('status 400');
    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('refuses the next request with the 401 challenge once YNAB refuses the refresh (G6)', async () => {
    const app = await createHttpApp(makeConfig());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alice = await connect(app, 'read-only');
    rotateOnEveryResolve();
    await initialize(app, alice.access);
    // The user revoked the app at YNAB: the stored refresh token no longer works.
    refreshAccessTokenMock.mockRejectedValue(new Error('YNAB token request failed with status 400 (invalid_grant)'));

    const call = await mcp(app, 'post', alice.access).send(getUserCall(3));
    expect(call.status).toBe(401);
    expect(call.body).toEqual({ error: 'invalid_token', error_description: 'Invalid or expired access token' });
    expect(call.headers['www-authenticate']).toBe(
      'Bearer error="invalid_token", error_description="Invalid or expired access token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
    );
    expect(`${call.text} ${String(call.headers['www-authenticate'])}`).not.toMatch(/invalid_grant|status 400/);
    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
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
