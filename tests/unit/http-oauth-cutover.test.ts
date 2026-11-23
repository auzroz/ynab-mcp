/**
 * The cut-over (#47-4, ADR-0002 D5, D6, D8): oidc-provider mounted behind the
 * AS stages of the real app (buildHttpApp), end to end, with YNAB mocked.
 *
 *   - one whole authorization: registration, /authorize, the consent page
 *     (the library's interaction), YNAB, the library's resume, the code
 *     exchange, /mcp, a refresh and a revocation;
 *   - D8's route answers: POST /authorize and every other wrong method is
 *     405, preflights are answered by cors-origin, discovery and /jwks are
 *     the library's;
 *   - D6's grant-guard: another client's credential, and a consumed refresh
 *     token or code replayed after it expired, each revoke the grant;
 *   - D5's client-auth over the library, fail closed;
 *   - the authorize guard's pre-validation and its redirect net;
 *   - unused registration access tokens go with their client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import express from 'express';
import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { mountAuthorizationServer } from '../../src/auth/as-router.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import type { OAuthRowRecord } from '../../src/storage/types.js';
import type { HttpConfig } from '../../src/config/environment.js';
import { Encryptor } from '../../src/crypto.js';
import { MIN_ABANDONED_CLIENT_MS, YNAB_CALLBACK_DEADLINE_MS } from '../../src/auth/retention-defaults.js';
import { exchangeCode as ynabExchangeCode, getYnabUserId, refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { bearer, mcpInitialize } from './helpers/mcp-call.js';
import {
  PUBLIC_URL,
  REDIRECT_URI,
  CookieJar,
  authorizeUrl,
  browse,
  browserFlow,
  exchangeCode,
  pkcePair,
  refresh,
  registerClient,
} from './helpers/oidc-app.js';

const RESOURCE = `${PUBLIC_URL}/mcp`;

let handle: HttpApp;
let app: Express;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(ynabExchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access',
    refreshToken: 'ynab-refresh',
    expiresAt: Date.now() + 7_200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue('ynab-user-1');
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-2',
    refreshToken: 'ynab-refresh-2',
    expiresAt: Date.now() + 7_200_000,
  }));
  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      readOnly: false,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey: randomBytes(32).toString('base64'),
      tokenPepper: TEST_TOKEN_PEPPER,
    })
  );
  app = handle.app;
});

afterEach(async () => {
  await handle.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function signIn(metadata: Record<string, unknown> = {}) {
  const client = await registerClient(app, metadata);
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge, resource: RESOURCE });
  const code = flow.params.get('code') as string;
  return { client, verifier, code, flow };
}

describe('one authorization through the mounted library', () => {
  it('registers, authorizes, exchanges, calls /mcp, refreshes and revokes', async () => {
    const { client, verifier, code, flow } = await signIn();
    expect(flow.params.get('iss')).toBe(`${PUBLIC_URL}/`);
    expect(flow.params.get('state')).toBe('client-state');
    const tokens = await exchangeCode(app, { clientId: client.clientId, code, verifier, resource: RESOURCE });
    expect(tokens.status).toBe(200);
    const access = tokens.body.access_token as string;
    expect((await mcpInitialize(app, bearer(access))).status).toBe(200);

    const refreshed = await refresh(app, { clientId: client.clientId, refreshToken: tokens.body.refresh_token as string });
    expect(refreshed.status).toBe(200);
    expect((await mcpInitialize(app, bearer(refreshed.body.access_token as string))).status).toBe(200);

    const revoked = await request(app)
      .post('/revoke')
      .type('form')
      .send({ token: refreshed.body.refresh_token, client_id: client.clientId });
    expect(revoked.status).toBe(200);
    expect((await mcpInitialize(app, bearer(refreshed.body.access_token as string))).status).toBe(401);
  });
});

describe('registrations as real clients send them', () => {
  it('accepts scope, grant types, response types and software fields, and signs in read-write', async () => {
    const reg = await request(app)
      .post('/register')
      .send({
        redirect_uris: [REDIRECT_URI],
        client_name: 'Claude-like',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'read-only read-write',
        software_id: 'claude-like',
        software_version: '1.2.3',
      });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    // The library's client `scope` is OIDC's; ours are asked for at /authorize, so it isn't kept.
    // Nor are the software fields: the library keeps only the metadata it recognizes.
    expect(reg.body.scope).toBeUndefined();
    expect(reg.body.software_id).toBeUndefined();
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(app, new CookieJar(), { clientId, challenge, scope: 'read-only read-write', choice: 'read-write' });
    const tokens = await exchangeCode(app, {
      clientId,
      clientSecret: reg.body.client_secret as string,
      code: flow.params.get('code') as string,
      verifier,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.scope).toBe('read-only read-write');
  });

  it('an authorization without redirect_uri uses the only registered one', async () => {
    const client = await registerClient(app);
    const { challenge } = pkcePair();
    const url = new URL(authorizeUrl({ clientId: client.clientId, challenge }), PUBLIC_URL);
    url.searchParams.delete('redirect_uri');
    const res = await request(app).get(`${url.pathname}${url.search}`);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toMatch(/\/oauth\/interaction\/[A-Za-z0-9_-]{43}$/);
  });
});

describe('the YNAB legs, as McpOAuthProvider tested them (moved from mcp-provider.test.ts)', () => {
  it('a sign-in whose YNAB exchange runs past its deadline saves no user or code and answers server_error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(ynabExchangeCode).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + YNAB_CALLBACK_DEADLINE_MS + 1);
      return { accessToken: 'ynab-access', refreshToken: 'ynab-refresh', expiresAt: Date.now() + 7_200_000 };
    });
    // An interaction that outlives the deadline (the default MCP_AUTH_CODE_TTL_SEC equals it, and
    // an expired interaction ends on this server's own page instead of a redirect; see below).
    const as = mountedAs({ authCodeTtlSec: 1800 });
    const client = await registerClient(as.app);
    const { challenge } = pkcePair();
    const flow = await browserFlow(as.app, new CookieJar(), { clientId: client.clientId, challenge });
    expect(flow.params.get('error')).toBe('server_error');
    expect(flow.params.has('code')).toBe(false);
    expect(flow.params.get('iss')).toBe(`${PUBLIC_URL}/`);
    expect(await as.storage.getUser('ynab-user-1')).toBeUndefined();
  });

  it('with the default lifetimes, a sign-in past the deadline ends on this server\'s page and saves nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(ynabExchangeCode).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + YNAB_CALLBACK_DEADLINE_MS + 1);
      return { accessToken: 'ynab-access', refreshToken: 'ynab-refresh', expiresAt: Date.now() + 7_200_000 };
    });
    const client = await registerClient(app);
    const { challenge } = pkcePair();
    const jar = new CookieJar();
    const auth = await browse(app, jar, authorizeUrl({ clientId: client.clientId, challenge }));
    const uid = /\/oauth\/interaction\/([A-Za-z0-9_-]{43})$/.exec(auth.headers['location'] as string)?.[1] as string;
    const start = await browse(app, jar, `/oauth/interaction/${uid}/start?scope=read-only`);
    const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;
    const callback = await browse(app, jar, `/oauth/ynab/callback?${new URLSearchParams({ state, code: 'c' }).toString()}`);
    const complete = await browse(app, jar, callback.headers['location'] as string);
    expect(complete.status).toBe(400);
    expect(complete.headers['location']).toBeUndefined();
    expect(await created.storage!.getUser('ynab-user-1')).toBeUndefined();
  });

  it('/revoke answers a storage failure with a generic server_error, without its details', async () => {
    const pair = await tokenPair();
    vi.spyOn(created.storage!, 'destroyOAuthRow').mockRejectedValue(
      new Error('connect ECONNREFUSED 10.1.2.3:5432 (postgres://app:hunter2@db.internal/ynab)')
    );
    const res = await request(app).post('/revoke').type('form').send({ token: pair.access, client_id: pair.client.clientId });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.text).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/);
  });

  it('the deadline is shorter than the shortest sweep protection of a client', () => {
    expect(YNAB_CALLBACK_DEADLINE_MS).toBeLessThan(MIN_ABANDONED_CLIENT_MS);
  });

  it('the consent page promises no in-app disconnect; it points to YNAB, where access can be removed', async () => {
    const client = await registerClient(app);
    const { challenge } = pkcePair();
    const jar = new CookieJar();
    const auth = await browse(app, jar, authorizeUrl({ clientId: client.clientId, challenge }));
    const page = await browse(app, jar, auth.headers['location'] as string);
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/disconnect/i);
    expect(page.text).toContain(
      'To end this access later, open your YNAB settings at app.ynab.com/settings, find Authorized Applications, ' +
        "and choose Revoke next to this server's app."
    );
  });
});

const DAY = 86_400_000;

/** A signed-in client holding a token pair. */
async function tokenPair(metadata: Record<string, unknown> = {}) {
  const { client, verifier, code } = await signIn(metadata);
  const res = await exchangeCode(app, { clientId: client.clientId, code, verifier, resource: RESOURCE });
  expect(res.status).toBe(200);
  return {
    client,
    verifier,
    code,
    access: res.body.access_token as string,
    refreshToken: res.body.refresh_token as string,
  };
}

const INVALID_GRANT = { error: 'invalid_grant', error_description: 'grant request is invalid' };

describe('grant-guard (ADR-0002 D6): RFC 9700 revocations the library leaves out', () => {
  it('a live refresh token presented by another client revokes its grant', async () => {
    const owner = await tokenPair();
    const other = await registerClient(app);
    const res = await refresh(app, { clientId: other.clientId, refreshToken: owner.refreshToken });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_GRANT);
    // The family is gone: the owner's own refresh and access token no longer work.
    expect((await refresh(app, { clientId: owner.client.clientId, refreshToken: owner.refreshToken })).status).toBe(400);
    expect((await mcpInitialize(app, bearer(owner.access))).status).toBe(401);
  });

  it('a live code presented by another client revokes its grant, so the owner can no longer redeem it', async () => {
    const { client, verifier, code } = await signIn();
    const other = await registerClient(app);
    const stolen = await exchangeCode(app, { clientId: other.clientId, code, verifier });
    expect(stolen.body).toEqual(INVALID_GRANT);
    const owner = await exchangeCode(app, { clientId: client.clientId, code, verifier });
    expect(owner.status).toBe(400);
    expect(owner.body.error).toBe('invalid_grant');
  });

  it('a consumed refresh token replayed after it expired (within the retention window) revokes the grant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T = Date.now();
    const first = await tokenPair();
    // Rotated at T + 10 days: the successor lives to T + 40 days (the 30-day idle window).
    vi.setSystemTime(T + 10 * DAY);
    const rotated = await refresh(app, { clientId: first.client.clientId, refreshToken: first.refreshToken });
    expect(rotated.status).toBe(200);
    const successor = rotated.body.refresh_token as string;
    // T + 31 days: the original expired at T + 30 days and was consumed at T + 10 days, so it is
    // still retained (30 days after consumption). The library alone would only say "expired".
    vi.setSystemTime(T + 31 * DAY);
    const replay = await refresh(app, { clientId: first.client.clientId, refreshToken: first.refreshToken });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(INVALID_GRANT);
    // The successor went with the grant.
    const next = await refresh(app, { clientId: first.client.clientId, refreshToken: successor });
    expect(next.status).toBe(400);
    expect(next.body.error).toBe('invalid_grant');
  });

  it('a consumed code replayed after it expired revokes the grant: the tokens issued from it stop working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T = Date.now();
    const pair = await tokenPair();
    // Codes live 10 minutes (MCP_AUTH_CODE_TTL_SEC); the access token an hour.
    vi.setSystemTime(T + 20 * 60_000);
    const replay = await exchangeCode(app, { clientId: pair.client.clientId, code: pair.code, verifier: pair.verifier });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(INVALID_GRANT);
    expect((await mcpInitialize(app, bearer(pair.access))).status).toBe(401);
    expect((await refresh(app, { clientId: pair.client.clientId, refreshToken: pair.refreshToken })).body.error).toBe(
      'invalid_grant'
    );
  });

  it('a live credential presented by its own client goes on to the library', async () => {
    const pair = await tokenPair();
    expect((await refresh(app, { clientId: pair.client.clientId, refreshToken: pair.refreshToken })).status).toBe(200);
  });
});

describe('D8: methods and routes', () => {
  it('POST /authorize answers 405 with Allow: GET (only GET is served)', async () => {
    const res = await request(app).post('/authorize').type('form').send({ client_id: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
    expect(res.body.error).toBe('method_not_allowed');
  });

  it.each([
    ['get', '/token'],
    ['get', '/revoke'],
    ['get', '/register'],
    ['post', '/.well-known/oauth-authorization-server'],
    ['post', '/.well-known/openid-configuration'],
    ['post', '/jwks'],
    ['delete', '/.well-known/oauth-protected-resource/mcp'],
  ] as const)('%s %s answers 405', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('method_not_allowed');
  });

  it('serves both discovery documents and /jwks from the library', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const doc = await request(app).get(path);
      expect(doc.status).toBe(200);
      expect(doc.body).toMatchObject({
        issuer: `${PUBLIC_URL}/`,
        authorization_endpoint: `${PUBLIC_URL}/authorize`,
        token_endpoint: `${PUBLIC_URL}/token`,
        registration_endpoint: `${PUBLIC_URL}/register`,
        revocation_endpoint: `${PUBLIC_URL}/revoke`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['read-only', 'read-write'],
        response_modes_supported: ['query'],
      });
    }
    expect((await request(app).get('/jwks')).status).toBe(200);
  });

  it('the old 0.4.x legs are gone: /oauth/ynab/start and /oauth/cancel', async () => {
    expect((await request(app).get('/oauth/ynab/start').query({ state: 'x' })).status).toBe(404);
    expect((await request(app).get('/oauth/cancel').query({ state: 'x' })).status).toBe(404);
  });
});

describe('the authorize guard over the library (#55b)', () => {
  async function authorize(clientId: string, extra: Record<string, string>) {
    const { challenge } = pkcePair();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      ...extra,
    });
    return request(app).get(`/authorize?${query.toString()}`);
  }

  it.each([
    ['prompt=none', { prompt: 'none' }, 'login_required'],
    ['an unknown prompt', { prompt: 'select_account' }, 'invalid_request'],
    ['a request object', { request: 'eyJ.x.y' }, 'request_not_supported'],
    ['response_type=token', { response_type: 'token' }, 'unsupported_response_type'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['a foreign resource', { resource: 'https://evil.example/mcp' }, 'invalid_target'],
  ])('%s from an unverified client: this server\'s error page, never a redirect', async (_name, extra, error) => {
    const client = await registerClient(app);
    const res = await authorize(client.clientId, extra);
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(error);
  });

  it('response_mode=form_post is dropped: the authorization still goes to the consent page', async () => {
    const client = await registerClient(app);
    const res = await authorize(client.clientId, { response_mode: 'form_post' });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toMatch(/^https:\/\/mcp\.example\.com\/oauth\/interaction\/[A-Za-z0-9_-]{43}$/);
  });

  it('the redirect net: an error redirect the stage did not foresee becomes the error page', async () => {
    // A library refusal no pre-validation covers, forced through the library's own error path:
    // its error handler redirects any exposed, redirectable error to the client.
    const as = mountedAs();
    const client = await registerClient(as.app);
    // The library's errors carry their code as the message (errOut reads it).
    const unforeseen = Object.assign(new Error('temporarily_unavailable'), {
      allow_redirect: true,
      expose: true,
      error: 'temporarily_unavailable',
      error_description: 'try later',
      statusCode: 400,
    });
    const save = vi.spyOn(as.server.oidc.Interaction.prototype, 'save').mockRejectedValue(unforeseen);
    const { challenge } = pkcePair();
    const res = await request(as.app).get(authorizeUrl({ clientId: client.clientId, challenge }));
    expect(save).toHaveBeenCalled();
    expect(res.headers['location']).toBeUndefined();
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('temporarily_unavailable');
    // The same error for a verified redirect URI is redirected, with iss.
    const verified = mountedAs({ verifiedRedirectUris: new Set([REDIRECT_URI]) });
    const trusted = await registerClient(verified.app);
    vi.spyOn(verified.server.oidc.Interaction.prototype, 'save').mockRejectedValue(unforeseen);
    const redirected = await request(verified.app).get(authorizeUrl({ clientId: trusted.clientId, challenge }));
    expect(redirected.status).toBe(303);
    const target = new URL(redirected.headers['location'] as string);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT_URI);
    expect(target.searchParams.get('error')).toBe('temporarily_unavailable');
    expect(target.searchParams.get('iss')).toBe(`${PUBLIC_URL}/`);
  });
});

describe('registration access tokens go with their client', () => {
  it('DCR leaves one; deleting the client takes it', async () => {
    const as = mountedAs();
    const client = await registerClient(as.app);
    const rows = (model: string): number =>
      [...(as.storage as unknown as { oauthRows: Map<string, OAuthRowRecord> }).oauthRows.values()].filter(
        (r) => r.model === model && r.clientId === client.clientId
      ).length;
    expect(rows('RegistrationAccessToken')).toBe(1);
    await as.server.oidc.Client.adapter.destroy(client.clientId);
    expect(rows('Client')).toBe(0);
    expect(rows('RegistrationAccessToken')).toBe(0);
  });
});

/** The authorization server alone on an app of its own, over memory storage, to reach its library instance. */
function mountedAs(overrides: Partial<HttpConfig> = {}) {
  const storage = new MemoryStorage();
  const app = express();
  const config = makeHttpConfig({
    publicUrl: PUBLIC_URL,
    resourceUrl: RESOURCE,
    authMode: 'oauth',
    oauthClientId: 'ynab-client-id',
    oauthClientSecret: 'ynab-client-secret',
    encryptionKey: randomBytes(32).toString('base64'),
    ...overrides,
  });
  const server = mountAuthorizationServer(app, {
    config,
    storage,
    encryptor: new Encryptor(config.encryptionKey as string),
    tokenHasher: TEST_TOKEN_HASHER,
    ynab: { clientId: 'ynab-client-id', clientSecret: 'ynab-client-secret' },
  });
  return { app, server, storage };
}
