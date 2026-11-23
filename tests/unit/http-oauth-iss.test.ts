/**
 * RFC 9207 issuer identification end to end over HTTP: every redirect from the
 * authorization flow back to the client's redirect URI carries `iss` equal to
 * the AS metadata `issuer`, and nothing else gets it. Only the YNAB network
 * calls are mocked.
 *
 * Since #47-4 the authorization server is oidc-provider: the consent page is
 * its interaction (/oauth/interaction/:uid, reached by a 303 from /authorize),
 * the browser is bound by its interaction cookies (Secure, so a CookieJar
 * carries them), and every authorization response, code or error, leaves
 * through its resume route (/authorize/:uid), which sends `iss`.
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
import { CookieJar, browse, interactionUid } from './helpers/oidc-app.js';
import type { HttpConfig } from '../../src/config/environment.js';

const exchangeCodeMock = vi.mocked(ynabOauth.exchangeCode);

const ORIGIN = 'https://mcp.example.com';
const CALLBACK = 'https://client.example/cb';
const ISSUER = 'https://mcp.example.com/';

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return makeHttpConfig({
    publicUrl: ORIGIN,
    resourceUrl: `${ORIGIN}/mcp`,
    readOnly: false,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    // A verified client (#55b): only its authorization errors are redirected,
    // which is what these tests check. Unverified clients: http-oauth-dcr-authorize.test.ts.
    verifiedRedirectUris: [CALLBACK],
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

const authorizePath = (query: Record<string, string>): string => `/authorize?${new URLSearchParams(query).toString()}`;

/** /authorize in `jar`'s browser up to the consent page: the interaction's uid and the page. */
async function consentPage(
  app: Express,
  jar: CookieJar,
  query: Record<string, string>
): Promise<{ uid: string; html: string }> {
  const auth = await browse(app, jar, authorizePath(query));
  expect(auth.status).toBe(303);
  const uid = interactionUid(auth.headers['location'] as string);
  const page = await browse(app, jar, auth.headers['location'] as string);
  expect(page.status).toBe(200);
  return { uid, html: page.text };
}

/** The consent page's read-only choice: the redirect to YNAB and the state it carries. */
async function toYnab(app: Express, jar: CookieJar, uid: string): Promise<{ res: request.Response; state: string }> {
  const res = await browse(app, jar, `/oauth/interaction/${uid}/start?scope=read-only`);
  expect(res.status).toBe(302);
  return { res, state: new URL(res.headers['location'] as string).searchParams.get('state') as string };
}

/**
 * Follow redirects on this server (callback, complete, the library's resume)
 * from `path`, in `jar`'s browser; returns the first answer that isn't a
 * redirect to this server: the authorization response to the client, or a refusal.
 */
async function follow(app: Express, jar: CookieJar, path: string, proxyPrefix = ''): Promise<request.Response> {
  let res = await browse(app, jar, path);
  for (let hops = 0; hops < 5; hops++) {
    const loc = res.headers['location'] as string | undefined;
    if (res.status < 300 || res.status >= 400 || loc === undefined || new URL(loc, ORIGIN).origin !== ORIGIN) return res;
    // A reverse proxy serving the app under PUBLIC_URL's path strips that prefix.
    const target = new URL(loc, ORIGIN);
    if (proxyPrefix !== '' && target.pathname.startsWith(`${proxyPrefix}/`)) {
      target.pathname = target.pathname.slice(proxyPrefix.length);
    }
    res = await browse(app, jar, target.href);
  }
  throw new Error('too many redirects');
}

/** YNAB's redirect back to the callback with `query`, followed to the client. */
function ynabReturns(
  app: Express,
  jar: CookieJar,
  query: Record<string, string>,
  proxyPrefix = ''
): Promise<request.Response> {
  return follow(app, jar, `/oauth/ynab/callback?${new URLSearchParams(query).toString()}`, proxyPrefix);
}

async function metadataIssuer(app: Express): Promise<string> {
  const res = await request(app).get('/.well-known/oauth-authorization-server');
  expect(res.status).toBe(200);
  return res.body.issuer as string;
}

/** The authorization response to the client: a redirect off this server. */
function location(res: request.Response): URL {
  expect([302, 303]).toContain(res.status);
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
    const jar = new CookieJar();
    const { uid } = await consentPage(app, jar, authorizeQuery(clientId));

    const { state } = await toYnab(app, jar, uid);
    const back = await ynabReturns(app, jar, { code: 'ynab-code', state });
    const loc = location(back);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('iss')).toBe(issuer);
    expect(loc.searchParams.get('state')).toBe('client-state');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();

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
    const app = await createHttpApp(makeConfig({ verifiedRedirectUris: [redirectUri] }));
    const clientId = await register(app, redirectUri);
    const query = authorizeQuery(clientId, {}, redirectUri);
    delete query['state'];
    const jar = new CookieJar();
    const { uid } = await consentPage(app, jar, query);
    const { state } = await toYnab(app, jar, uid);

    const loc = location(await ynabReturns(app, jar, { code: 'ynab-code', state }));
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
    const jar = new CookieJar();
    // A reverse proxy serves the app under PUBLIC_URL's path (/ynab) and strips it. The browser
    // holds its cookies under the public path, so they are sent as for that path.
    const viaProxy = async (url: string): Promise<request.Response> => {
      const target = new URL(url, ORIGIN);
      const publicPath = target.pathname;
      if (target.pathname.startsWith('/ynab/')) target.pathname = target.pathname.slice('/ynab'.length);
      const res = await request(app).get(`${target.pathname}${target.search}`).set('Cookie', jar.header(publicPath));
      jar.take(res);
      return res;
    };
    let res = await viaProxy(authorizePath(authorizeQuery(clientId)));
    expect(res.status).toBe(303);
    // The library's redirect to the consent page carries the path, like every other /oauth link.
    expect(res.headers['location']).toMatch(/^https:\/\/mcp\.example\.com\/ynab\/oauth\/interaction\//);
    const consent = await viaProxy(res.headers['location'] as string);
    expect(consent.status).toBe(200);
    const start = /href="([^"]+start\?scope=read-only)"/.exec(consent.text)?.[1]?.replaceAll('&amp;', '&');
    expect(start).toMatch(/^https:\/\/mcp\.example\.com\/ynab\/oauth\/interaction\//);
    res = await viaProxy(start as string);
    expect(res.status).toBe(302);
    const state = new URL(res.headers['location'] as string).searchParams.get('state') as string;
    res = await viaProxy(`/ynab/oauth/ynab/callback?${new URLSearchParams({ code: 'ynab-code', state }).toString()}`);
    for (let hops = 0; hops < 5 && res.status >= 300 && res.status < 400; hops++) {
      const loc = new URL(res.headers['location'] as string, ORIGIN);
      if (loc.origin !== ORIGIN) break;
      res = await viaProxy(loc.href);
    }
    const back = res;
    expect(location(back).searchParams.get('iss')).toBe(issuer);
    const err = await request(app).get('/authorize').query(authorizeQuery(clientId, { code_challenge_method: 'plain' }));
    expect(location(err).searchParams.get('iss')).toBe(issuer);
  });
});

describe('error authorization responses', () => {
  it('a parameter error redirect (invalid_request) has iss, error and state', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const res = await request(app)
      .get('/authorize')
      .query(authorizeQuery(clientId, { code_challenge_method: 'plain' }));
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.getAll('iss')).toHaveLength(1);
  });

  it('POST /authorize is not served: 405, never a redirect (ADR-0002 D8)', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const res = await request(app)
      .post('/authorize')
      .type('form')
      .send(authorizeQuery(clientId, { response_type: 'token' }));
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
    expect(res.headers['location']).toBeUndefined();
    expect(res.body.error).toBe('method_not_allowed');
  });

  it('a resource error redirect (invalid_target for a foreign resource) has iss and state', async () => {
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
    const jar = new CookieJar();
    const { uid, html } = await consentPage(app, jar, authorizeQuery(clientId));
    expect(html).toContain(`https://mcp.example.com/oauth/interaction/${uid}/cancel`);

    const res = await follow(app, jar, `/oauth/interaction/${uid}/cancel`);
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('error_description')).toBe('The user denied the authorization request');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.has('code')).toBe(false);

    // The interaction is gone: it can be neither cancelled again nor resumed.
    const again = await browse(app, jar, `/oauth/interaction/${uid}/cancel`);
    expect(again.status).toBe(400);
    expect(again.headers['location']).toBeUndefined();
    const start = await browse(app, jar, `/oauth/interaction/${uid}/start?scope=read-only`);
    expect(start.status).toBe(400);
  });

  it('Cancel for an unknown interaction, or from a browser without its cookie, is a 400 with no redirect', async () => {
    const app = await createHttpApp(makeConfig());
    const unknown = await browse(app, new CookieJar(), `/oauth/interaction/${'A'.repeat(43)}/cancel`);
    expect(unknown.status).toBe(400);
    expect(unknown.headers['location']).toBeUndefined();

    const clientId = await register(app);
    const { uid } = await consentPage(app, new CookieJar(), authorizeQuery(clientId));
    const otherBrowser = await browse(app, new CookieJar(), `/oauth/interaction/${uid}/cancel`);
    expect(otherBrowser.status).toBe(400);
    expect(otherBrowser.headers['location']).toBeUndefined();
  });

  it('YNAB denial (error=access_denied) becomes access_denied to the client with iss', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const jar = new CookieJar();
    const { uid } = await consentPage(app, jar, authorizeQuery(clientId));
    const { state } = await toYnab(app, jar, uid);

    const res = await ynabReturns(app, jar, { error: 'access_denied', error_description: 'User said no', state });
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
    const jar = new CookieJar();
    const { uid } = await consentPage(app, jar, authorizeQuery(clientId));
    const { state } = await toYnab(app, jar, uid);
    const res = await ynabReturns(app, jar, {
      error: 'temporarily_unavailable',
      error_description: 'internal-host-42 down',
      state,
    });
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
    const jar = new CookieJar();
    const { uid } = await consentPage(app, jar, authorizeQuery(clientId));
    const { state } = await toYnab(app, jar, uid);

    const res = await ynabReturns(app, jar, { code: 'ynab-code', state });
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
    const replay = await ynabReturns(app, jar, { code: 'ynab-code', state });
    expect(replay.status).toBe(400);
    expect(replay.headers['location']).toBeUndefined();
  });
});

describe('redirects that are not authorization responses', () => {
  it('the redirect to YNAB carries no iss and keeps its own parameters', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const jar = new CookieJar();
    const { uid } = await consentPage(app, jar, authorizeQuery(clientId));
    const { res, state } = await toYnab(app, jar, uid);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.origin + loc.pathname).toBe('https://app.ynab.com/oauth/authorize');
    expect(loc.searchParams.has('iss')).toBe(false);
    expect([...loc.searchParams.keys()].sort()).toEqual(
      ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'].sort()
    );
    // The interaction's uid and a one-time value (src/auth/oidc/interaction.ts).
    expect(state.startsWith(`${uid}.`)).toBe(true);
  });

  it('the redirect from /authorize to the consent page carries no iss', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const auth = await browse(app, new CookieJar(), authorizePath(authorizeQuery(clientId)));
    expect(auth.status).toBe(303);
    expect(new URL(auth.headers['location'] as string, ORIGIN).searchParams.has('iss')).toBe(false);
  });
});
