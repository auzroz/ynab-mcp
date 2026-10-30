/**
 * RFC 9207 issuer identification end to end over HTTP: every redirect from the
 * authorization flow back to the client's redirect URI carries `iss` equal to
 * the AS metadata `issuer`, and nothing else gets it. Only the YNAB network
 * calls are mocked.
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
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
    refreshAccessToken: vi.fn(),
  };
});

import { createHttpApp } from '../../src/http.js';
import * as ynabOauth from '../../src/auth/ynab-oauth.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { cookieHeaderFrom } from './helpers/consent-cookie.js';
import type { HttpConfig } from '../../src/config/environment.js';

const exchangeCodeMock = vi.mocked(ynabOauth.exchangeCode);

const CALLBACK = 'https://client.example/cb';
const ISSUER = 'https://mcp.example.com/';

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

async function register(app: Express, redirectUri = CALLBACK): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [redirectUri], client_name: 'iss', token_endpoint_auth_method: 'none' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

function authorizeQuery(
  clientId: string,
  extra: Record<string, string> = {},
  redirectUri = CALLBACK
): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    ...extra,
  };
}

/**
 * GET /authorize and return our pending-auth state from the consent page, and
 * the consent cookie (as a Cookie header) the later legs require.
 */
async function consentState(
  app: Express,
  clientId: string,
  extra: Record<string, string> = {},
  redirectUri = CALLBACK
): Promise<{ state: string; html: string; cookie: string }> {
  const res = await request(app).get('/authorize').query(authorizeQuery(clientId, extra, redirectUri));
  expect(res.status).toBe(200);
  const m = /state=([^&"]+)&amp;scope=read-only/.exec(res.text);
  if (!m?.[1]) throw new Error('no consent link');
  return { state: decodeURIComponent(m[1]), html: res.text, cookie: cookieHeaderFrom(res) };
}

async function metadataIssuer(app: Express): Promise<string> {
  const res = await request(app).get('/.well-known/oauth-authorization-server');
  expect(res.status).toBe(200);
  return res.body.issuer as string;
}

function location(res: request.Response): URL {
  expect(res.status).toBe(302);
  return new URL(res.headers['location'] as string);
}

beforeEach(() => {
  exchangeCodeMock.mockReset();
  exchangeCodeMock.mockResolvedValue({
    accessToken: 'ya',
    refreshToken: 'yr',
    expiresAt: Date.now() + 7200_000,
  });
});

describe('AS metadata (RFC 9207 section 3)', () => {
  it('advertises authorization_response_iss_parameter_supported and keeps the SDK fields', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.authorization_response_iss_parameter_supported).toBe(true);
    expect(res.body.issuer).toBe(ISSUER);
    expect(res.body.authorization_endpoint).toBe('https://mcp.example.com/authorize');
    expect(res.body.token_endpoint).toBe('https://mcp.example.com/token');
    expect(res.body.registration_endpoint).toBe('https://mcp.example.com/register');
    expect(res.body.revocation_endpoint).toBe('https://mcp.example.com/revoke');
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.body.scopes_supported).toEqual(['read-only', 'read-write']);
  });
});

describe('successful authorization response', () => {
  it('carries code, state and iss equal to the metadata issuer; the code still redeems', async () => {
    const app = await createHttpApp(makeConfig());
    const issuer = await metadataIssuer(app);
    const clientId = await register(app);
    const { state, cookie } = await consentState(app, clientId);

    const start = await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: 'read-only' });
    const cb = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
    const loc = location(cb);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('iss')).toBe(issuer);
    expect(loc.searchParams.get('state')).toBe('client-state');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(start.status).toBe(302);

    const tok = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code as string,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
    });
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toBeTruthy();
  });

  it('keeps a query in the registered redirect URI and omits state when the client sent none', async () => {
    const redirectUri = 'https://client.example/cb?tenant=t%201';
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app, redirectUri);
    const query = authorizeQuery(clientId, {}, redirectUri);
    delete query['state'];
    const consent = await request(app).get('/authorize').query(query);
    const m = /state=([^&"]+)&amp;scope=read-only/.exec(consent.text);
    const state = decodeURIComponent(m?.[1] ?? '');
    const cookie = cookieHeaderFrom(consent);

    const cb = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
    const loc = location(cb);
    expect(loc.searchParams.get('tenant')).toBe('t 1');
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.has('state')).toBe(false);
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
  });

  it('uses the issuer exactly as published when PUBLIC_URL has a path', async () => {
    const app = await createHttpApp(
      makeConfig({ publicUrl: 'https://mcp.example.com/ynab', resourceUrl: 'https://mcp.example.com/ynab/mcp' })
    );
    const issuer = await metadataIssuer(app);
    expect(issuer).toBe('https://mcp.example.com/ynab');
    const clientId = await register(app);
    const { state, cookie } = await consentState(app, clientId);
    const cb = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
    expect(location(cb).searchParams.get('iss')).toBe(issuer);
    const err = await request(app).get('/authorize').query(authorizeQuery(clientId, { code_challenge_method: 'plain' }));
    expect(location(err).searchParams.get('iss')).toBe(issuer);
  });
});

describe('error authorization responses', () => {
  it('SDK error redirect (invalid_request) has iss and error', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const res = await request(app)
      .get('/authorize')
      .query(authorizeQuery(clientId, { code_challenge_method: 'plain' }));
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    // (SDK 1.32 drops `state` when the request fails schema validation; the
    // invalid_target case below shows state is kept when the SDK has parsed it.)
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.getAll('iss')).toHaveLength(1);
  });

  it('SDK error redirect from POST /authorize has iss too', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const res = await request(app)
      .post('/authorize')
      .type('form')
      .send(authorizeQuery(clientId, { response_type: 'token' }));
    const loc = location(res);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
  });

  it('provider error redirect (invalid_target for a foreign resource) has iss and state', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const res = await request(app)
      .get('/authorize')
      .query(authorizeQuery(clientId, { resource: 'https://evil.example.com/mcp' }));
    const loc = location(res);
    expect(loc.searchParams.get('error')).toBe('invalid_target');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
  });

  it('pre-redirect errors (unknown client) are direct 400s, never redirects', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/authorize').query(authorizeQuery('no-such-client'));
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body.error).toBe('invalid_client');
  });

  it('Cancel on the consent screen returns access_denied with iss and state, once', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { state, html, cookie } = await consentState(app, clientId);
    expect(html).toContain(`https://mcp.example.com/oauth/cancel?state=${encodeURIComponent(state)}`);

    const res = await request(app).get('/oauth/cancel').set('Cookie', cookie).query({ state });
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('error_description')).toBe('The user denied the authorization request');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.has('code')).toBe(false);

    // The pending authorization is gone: it can be neither cancelled again nor resumed.
    const again = await request(app).get('/oauth/cancel').set('Cookie', cookie).query({ state });
    expect(again.status).toBe(400);
    expect(again.headers['location']).toBeUndefined();
    const start = await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: 'read-only' });
    expect(start.status).toBe(400);
  });

  it('Cancel with an unknown or missing state is a 400 with no redirect', async () => {
    const app = await createHttpApp(makeConfig());
    const unknown = await request(app).get('/oauth/cancel').query({ state: 'never-issued' });
    expect(unknown.status).toBe(400);
    expect(unknown.headers['location']).toBeUndefined();
    const missing = await request(app).get('/oauth/cancel');
    expect(missing.status).toBe(400);
    expect(missing.headers['location']).toBeUndefined();
  });

  it('YNAB denial (error=access_denied) becomes access_denied to the client with iss', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { state, cookie } = await consentState(app, clientId);
    await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: 'read-only' });

    const res = await request(app)
      .get('/oauth/ynab/callback')
      .set('Cookie', cookie)
      .query({ error: 'access_denied', error_description: 'User said no', state });
    const loc = location(res);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(res.headers['location']).not.toContain('User said no');
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('other YNAB errors map to server_error and never forward YNAB text', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { state, cookie } = await consentState(app, clientId);
    const res = await request(app)
      .get('/oauth/ynab/callback')
      .set('Cookie', cookie)
      .query({ error: 'temporarily_unavailable', error_description: 'internal-host-42 down', state });
    const loc = location(res);
    expect(loc.searchParams.get('error')).toBe('server_error');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(res.headers['location']).not.toContain('internal-host-42');
  });

  it('a YNAB error with an unknown state is a 400 with no redirect', async () => {
    const app = await createHttpApp(makeConfig());
    const res = await request(app).get('/oauth/ynab/callback').query({ error: 'access_denied', state: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
  });

  it('a failed YNAB code exchange redirects server_error with iss and state, no code, no internals', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exchangeCodeMock.mockRejectedValueOnce(new Error('YNAB token request failed with status 500'));
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { state, cookie } = await consentState(app, clientId);

    const res = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('server_error');
    expect(loc.searchParams.get('error_description')).toBe('Could not complete YNAB authorization');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.has('code')).toBe(false);
    expect(res.headers['location']).not.toContain('status 500');
    // Logged internally, without the YNAB code.
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('YNAB authorization could not be completed');
    expect(logged).not.toContain('ynab-code');
    errorSpy.mockRestore();

    // One-time: the same state cannot be replayed.
    const replay = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
    expect(replay.status).toBe(400);
  });
});

describe('redirects that are not authorization responses', () => {
  it('the redirect to YNAB carries no iss and keeps its own parameters', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const { state, cookie } = await consentState(app, clientId);
    const res = await request(app).get('/oauth/ynab/start').set('Cookie', cookie).query({ state, scope: 'read-only' });
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe('https://app.ynab.com/oauth/authorize');
    expect(loc.searchParams.has('iss')).toBe(false);
    expect([...loc.searchParams.keys()].sort()).toEqual(
      ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'].sort()
    );
    expect(loc.searchParams.get('state')).toBe(state);
  });
});
