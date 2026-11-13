/**
 * #55 end to end over HTTP: dynamic client registration rules (dcr-validator),
 * /authorize bounds and the grandfathered-client refusal
 * (authorize-validation), the open-redirect guard over every server-legacy
 * phase-2 error path (authorize-guard), and the consent page. Only the YNAB
 * network calls are absent (nothing here reaches them).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type { Storage } from '../../src/storage/types.js';

// Keeps a handle on the storage the app creates, to plant clients registered
// under older rules and to make a storage write fail.
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

import { createHttpApp } from '../../src/http.js';
import { McpOAuthProvider } from '../../src/auth/mcp-provider.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { Encryptor } from '../../src/crypto.js';
import { MAX_SCOPES, MAX_STATE_LENGTH } from '../../src/auth/authorize-validation.js';
import { PAGE_CSP } from '../../src/auth/auth-pages.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER } from './helpers/token-hasher.js';
import type { HttpConfig } from '../../src/config/environment.js';

const PUBLIC_URL = 'https://mcp.example.com';
const ISSUER = `${PUBLIC_URL}/`;
const CALLBACK = 'https://client.example/cb';
const ATTACKER = 'https://attacker.example/phish';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK = 'http://localhost:33418/callback';

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return makeHttpConfig({
    publicUrl: PUBLIC_URL,
    resourceUrl: `${PUBLIC_URL}/mcp`,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    ...overrides,
  });
}

const verifier = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(verifier).digest('base64url');

const storage = (): Storage => created.storage as Storage;

let app: Express;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  app = await createHttpApp(makeConfig());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await created.storage?.close();
  created.storage = undefined;
});

async function register(redirectUris: string[], extra: Record<string, unknown> = {}, on: Express = app): Promise<string> {
  const res = await request(on)
    .post('/register')
    .send({ redirect_uris: redirectUris, client_name: 'Test App', token_endpoint_auth_method: 'none', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.client_id as string;
}

/** A client saved straight to storage, as an older release could have registered it. */
async function plant(client: Record<string, unknown>): Promise<string> {
  const clientId = randomUUID();
  await storage().saveClient({ client_id: clientId, client_id_issued_at: 1, ...client } as unknown as OAuthClientInformationFull);
  return clientId;
}

function authorizeQuery(clientId: string, redirectUri: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    ...extra,
  };
}

const authorize = (clientId: string, redirectUri: string, extra: Record<string, unknown> = {}, on: Express = app) =>
  request(on).get('/authorize').query(authorizeQuery(clientId, redirectUri, extra));

/** The error page for an unverified client: no redirect, the error shown, the strict headers. */
function expectErrorPage(res: request.Response, error: string, status = 400): void {
  expect(res.status).toBe(status);
  expect(res.headers['location']).toBeUndefined();
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.headers['content-security-policy']).toBe(PAGE_CSP);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.text).toContain(`<code>${error}</code>`);
}

/** The page's "return to" link, decoded, or undefined. */
function returnLink(res: request.Response): URL | undefined {
  const m = /<a href="([^"]+)">return to /.exec(res.text);
  return m?.[1] ? new URL(m[1].replace(/&amp;/g, '&')) : undefined;
}

/**
 * An authorization error for this file's default client (client.example,
 * unverified): our error page (55b). Returns the error response's parameters,
 * from the page's return link.
 */
function refused(res: request.Response, error: string, status = 400): URLSearchParams {
  expectErrorPage(res, error, status);
  const link = returnLink(res);
  expect(link?.origin + (link?.pathname ?? '')).toBe(CALLBACK);
  return link!.searchParams;
}

/** A redirect error response for a verified client. */
function expectErrorRedirect(res: request.Response, redirectUri: string, error: string): URL {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers['location'] as string);
  expect(loc.origin + loc.pathname).toBe(redirectUri.split('?')[0]);
  expect(loc.searchParams.get('error')).toBe(error);
  expect(loc.searchParams.get('iss')).toBe(ISSUER);
  return loc;
}

describe('/register: our DCR rules (55a)', () => {
  it('drops jwks, contacts, software_statement, logo_uri and the other unused fields, stores none of them, and normalizes the name', async () => {
    const res = await request(app).post('/register').send({
      redirect_uris: [CALLBACK],
      client_name: '  Ｔｅｓｔ App ',
      token_endpoint_auth_method: 'none',
      jwks: { keys: [{ kty: 'RSA' }] },
      contacts: ['admin@attacker.example'],
      software_statement: 'eyJhbGciOiJub25lIn0.e30.',
      logo_uri: 'https://attacker.example/logo.png',
      client_uri: 'https://attacker.example',
      tos_uri: 'https://attacker.example/tos',
      policy_uri: 'https://attacker.example/policy',
      jwks_uri: 'https://attacker.example/jwks',
    });
    expect(res.status).toBe(201);
    expect(res.body.client_name).toBe('Test App');
    for (const field of ['jwks', 'contacts', 'software_statement', 'logo_uri', 'client_uri', 'tos_uri', 'policy_uri', 'jwks_uri']) {
      expect(res.body[field], field).toBeUndefined();
    }
    const stored = (await storage().getClient(res.body.client_id as string)) as unknown as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain('attacker.example');
  });

  it.each([
    ['six redirect URIs', { redirect_uris: Array.from({ length: 6 }, (_, i) => `${CALLBACK}${i}`) }, 'invalid_redirect_uri'],
    ['no redirect URI', { redirect_uris: [] }, 'invalid_redirect_uri'],
    ['a redirect URI over 512 characters', { redirect_uris: [`${CALLBACK}/${'a'.repeat(512)}`] }, 'invalid_redirect_uri'],
    ['plain http to a remote host', { redirect_uris: ['http://client.example/cb'] }, 'invalid_redirect_uri'],
    ['userinfo', { redirect_uris: ['https://user@client.example/cb'] }, 'invalid_redirect_uri'],
    ['a fragment', { redirect_uris: [`${CALLBACK}#frag`] }, 'invalid_redirect_uri'],
    ['a private-use scheme not on the allow-list', { redirect_uris: ['com.example.app:/cb'] }, 'invalid_redirect_uri'],
    ['javascript:', { redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
    ['a 101-character name', { redirect_uris: [CALLBACK], client_name: 'x'.repeat(101) }, 'invalid_client_metadata'],
    ['a name with bidi controls', { redirect_uris: [CALLBACK], client_name: 'Cla‮ude' }, 'invalid_client_metadata'],
    ['a name with zero-width characters', { redirect_uris: [CALLBACK], client_name: 'Cla​ude' }, 'invalid_client_metadata'],
    ['a name with control characters', { redirect_uris: [CALLBACK], client_name: 'Cla\nude' }, 'invalid_client_metadata'],
  ])('refuses %s with %s, readable by a browser client, without echoing the value', async (_name, body, error) => {
    const res = await request(app).post('/register').set('Origin', 'https://inspector.example').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(typeof res.body.error_description).toBe('string');
    expect(res.body.error_description).not.toContain('client.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts loopback http on any of the three hosts and marks the client native', async () => {
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: ['http://localhost:1/cb', 'http://127.0.0.1/cb', 'http://[::1]:9/cb'], token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
    expect(res.body.application_type).toBe('native');
  });

  it('accepts a private-use scheme the operator listed', async () => {
    const withScheme = await createHttpApp(makeConfig({ privateUseSchemes: ['com.example.app'] }));
    const res = await request(withScheme).post('/register').send({ redirect_uris: ['com.example.app:/oauth/cb'] });
    expect(res.status).toBe(201);
    expect(res.body.application_type).toBe('native');
  });

  it('the provider applies the same rules if the stage is bypassed (fail closed)', async () => {
    const provider = new McpOAuthProvider({
      storage: new MemoryStorage(),
      encryptor: new Encryptor(randomBytes(32).toString('base64')),
      tokenHasher: TEST_TOKEN_HASHER,
      ynab: { clientId: 'cid', clientSecret: 'sec' },
      publicUrl: PUBLIC_URL,
      allowWrite: true,
      globalReadOnly: false,
      accessTokenTtlSec: 3600,
      authCodeTtlSec: 600,
    });
    await expect(
      provider.clientsStore.registerClient!({ redirect_uris: ['http://attacker.example/cb'] } as OAuthClientInformationFull)
    ).rejects.toMatchObject({ errorCode: 'invalid_redirect_uri' });
    await expect(
      provider.clientsStore.registerClient!({ redirect_uris: [CALLBACK], client_name: 'a‮b' } as OAuthClientInformationFull)
    ).rejects.toMatchObject({ errorCode: 'invalid_client_metadata' });
    const ok = await provider.clientsStore.registerClient!({
      redirect_uris: [CALLBACK],
      logo_uri: 'https://attacker.example/logo.png',
      client_secret: 'plain-secret',
      client_secret_expires_at: 0,
    } as OAuthClientInformationFull);
    expect(ok.logo_uri).toBeUndefined();
    expect(ok.client_secret).toBe('plain-secret');
    expect(ok.client_secret_expires_at).toBe(0);
  });
});

describe('/authorize bounds (55a)', () => {
  it(`state: ${MAX_STATE_LENGTH} characters pass; more, or more than one, is invalid_request, never echoed`, async () => {
    const clientId = await register([CALLBACK]);
    expect((await authorize(clientId, CALLBACK, { state: 's'.repeat(MAX_STATE_LENGTH) })).status).toBe(200);
    const long = 's'.repeat(MAX_STATE_LENGTH + 1);
    const res = await authorize(clientId, CALLBACK, { state: long });
    expect(refused(res, 'invalid_request').has('state')).toBe(false);
    expect(res.text).not.toContain(long);
    const twice = await request(app).get(
      `/authorize?response_type=code&client_id=${clientId}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=a&state=b`
    );
    expect(refused(twice, 'invalid_request').has('state')).toBe(false);
  });

  it.each([
    ['42 characters', CHALLENGE.slice(0, 42)],
    ['44 characters', `${CHALLENGE}A`],
    ['a character outside base64url', `${CHALLENGE.slice(0, 42)}=`],
    ['missing', undefined],
  ])('code_challenge %s is invalid_request', async (_name, challenge) => {
    const clientId = await register([CALLBACK]);
    const params = refused(await authorize(clientId, CALLBACK, { code_challenge: challenge }), 'invalid_request');
    expect(params.get('error_description')).toBe('code_challenge must be a 43-character S256 challenge');
    // The state was valid, so the error response carries it.
    expect(params.get('state')).toBe('client-state');
  });

  it(`scope: ${MAX_SCOPES} values pass; more is invalid_scope`, async () => {
    const clientId = await register([CALLBACK]);
    const five = ['read-only', 'a', 'b', 'c', 'd'].join(' ');
    expect((await authorize(clientId, CALLBACK, { scope: five })).status).toBe(200);
    const six = ['read-only', 'a', 'b', 'c', 'd', 'e'].join(' ');
    refused(await authorize(clientId, CALLBACK, { scope: six }), 'invalid_scope');
  });

  it('unknown scopes are dropped before the handler (batch-3 default)', async () => {
    const clientId = await register([CALLBACK]);
    const save = vi.spyOn(storage(), 'savePendingAuth');
    const res = await authorize(clientId, CALLBACK, { scope: 'openid read-only profile read-only' });
    expect(res.status).toBe(200);
    expect(save.mock.calls[0]?.[0].scopes).toEqual(['read-only']);
    // Only read-only was asked for, so read-write isn't offered.
    expect(res.text).not.toContain('scope=read-write');

    const onlyUnknown = await authorize(clientId, CALLBACK, { scope: 'openid offline_access' });
    expect(onlyUnknown.status).toBe(200);
    expect(save.mock.calls[1]?.[0].scopes).toEqual([]);
  });

  it('applies the same bounds to POST /authorize', async () => {
    const clientId = await register([CALLBACK]);
    const res = await request(app)
      .post('/authorize')
      .type('form')
      .send(authorizeQuery(clientId, CALLBACK, { state: 'x'.repeat(MAX_STATE_LENGTH + 1) }));
    refused(res, 'invalid_request');
  });

  it('a verified client gets the bounds errors as RFC 6749 redirects with iss', async () => {
    const verified = await createHttpApp(makeConfig({ verifiedRedirectUris: [CALLBACK] }));
    const clientId = await register([CALLBACK], {}, verified);
    const loc = expectErrorRedirect(await authorize(clientId, CALLBACK, { code_challenge: 'short' }, verified), CALLBACK, 'invalid_request');
    expect(loc.searchParams.get('state')).toBe('client-state');
    const noState = expectErrorRedirect(
      await authorize(clientId, CALLBACK, { state: 'x'.repeat(MAX_STATE_LENGTH + 1) }, verified),
      CALLBACK,
      'invalid_request'
    );
    expect(noState.searchParams.has('state')).toBe(false);
    expectErrorRedirect(await authorize(clientId, CALLBACK, { scope: 'a b c d e f' }, verified), CALLBACK, 'invalid_scope');
  });

  it('a storage failure looking up the client is a generic 500, never a redirect', async () => {
    const clientId = await register([CALLBACK]);
    vi.spyOn(storage(), 'getClient').mockRejectedValueOnce(new Error('connect ECONNREFUSED db.internal:5432'));
    const res = await authorize(clientId, CALLBACK);
    expect(res.status).toBe(500);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).toEqual({ error: 'server_error', error_description: 'Internal Server Error' });
    expect(res.text).not.toContain('db.internal');
  });

  it('leaves the handler 400 JSON for an unknown client and an unregistered redirect URI', async () => {
    const unknown = await authorize('no-such-client', CALLBACK);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_client');
    const clientId = await register([CALLBACK]);
    const other = await authorize(clientId, ATTACKER);
    expect(other.status).toBe(400);
    expect(other.headers['location']).toBeUndefined();
    expect(other.body.error).toBe('invalid_request');
  });
});

describe('grandfathered clients (55a, batch-3 default)', () => {
  it('refuses a stored client with a plain-http redirect URI, on our page, with no link to it; logs once', async () => {
    const clientId = await plant({ redirect_uris: ['http://old.example/cb'], client_name: 'Old' });
    for (let i = 0; i < 2; i++) {
      const res = await authorize(clientId, 'http://old.example/cb');
      expectErrorPage(res, 'invalid_client');
      expect(res.text).not.toContain('old.example');
      expect(res.text).toContain('needs to register again');
    }
    const logged = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes(clientId));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('plain-http');
    expect(logged[0]).not.toContain('old.example');
  });

  it('refuses one even when the request names its https URI', async () => {
    const clientId = await plant({ redirect_uris: [CALLBACK, 'http://old.example/cb'] });
    expectErrorPage(await authorize(clientId, CALLBACK), 'invalid_client');
  });

  it('keeps accepting a stored client that fails only other rules, logging the rule names once', async () => {
    const clientId = await plant({
      redirect_uris: [CALLBACK, ...Array.from({ length: 5 }, (_, i) => `https://client.example/x${i}`)],
      client_name: 'Legacy​',
      logo_uri: 'https://client.example/logo.png',
    });
    expect((await authorize(clientId, CALLBACK)).status).toBe(200);
    expect((await authorize(clientId, CALLBACK)).status).toBe(200);
    const logged = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes(clientId));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('redirect_uris count; client_name; unsupported fields: logo_uri');
    expect(logged[0]).not.toContain('client.example');
  });

  it('accepts a stored loopback-http client', async () => {
    const clientId = await plant({ redirect_uris: ['http://127.0.0.1/cb'] });
    expect((await authorize(clientId, 'http://127.0.0.1:5000/cb')).status).toBe(200);
  });
});

/**
 * Every server-legacy 2.4.0 /authorize error after the client and redirect URI
 * are accepted (authorize-guard-legacy.ts lists them). For an unverified
 * client each one becomes our page; for a verified one it stays a redirect.
 */
const PHASE2: ReadonlyArray<{ name: string; error: string; status?: number; send: (on: Express, clientId: string, uri: string) => request.Test; arrange?: () => void }> = [
  {
    name: 'response_type other than code (schema)',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { response_type: 'token' })),
  },
  {
    name: 'code_challenge_method plain (schema)',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { code_challenge_method: 'plain' })),
  },
  {
    name: 'resource that is not a URL (schema)',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { resource: 'not a url' })),
  },
  {
    name: 'POST with a schema error',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).post('/authorize').type('form').send(authorizeQuery(id, uri, { response_type: 'token' })),
  },
  {
    name: 'provider OAuth error (invalid_target for a foreign resource)',
    error: 'invalid_target',
    send: (on, id, uri) =>
      request(on).get('/authorize').query(authorizeQuery(id, uri, { resource: 'https://evil.example/mcp' })),
  },
  {
    name: 'provider failure (storage error, server_error)',
    error: 'server_error',
    status: 500,
    arrange: () => {
      vi.spyOn(storage(), 'savePendingAuth').mockRejectedValueOnce(new Error('connect ECONNREFUSED db.internal:5432'));
    },
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri)),
  },
];

describe('authorize-guard: every phase-2 error path (55b)', () => {
  it.each(PHASE2)('unverified client, $name: our page, not a redirect', async ({ error, status, send, arrange }) => {
    const clientId = await register([CALLBACK]);
    arrange?.();
    const res = await send(app, clientId, CALLBACK);
    expectErrorPage(res, error, status);
    expect(res.text).not.toContain('db.internal');
    // The user may go back on their own: the link is the error response the client would have got.
    const link = returnLink(res);
    expect(link?.origin + (link?.pathname ?? '')).toBe(CALLBACK);
    expect(link?.searchParams.get('error')).toBe(error);
    expect(link?.searchParams.get('iss')).toBe(ISSUER);
    expect(res.text).toContain('return to client.example');
  });

  it.each(PHASE2)('verified client, $name: an RFC 6749 redirect with iss', async ({ error, send, arrange }) => {
    const verified = await createHttpApp(makeConfig({ verifiedRedirectUris: [CALLBACK] }));
    const clientId = await register([CALLBACK], {}, verified);
    arrange?.();
    expectErrorRedirect(await send(verified, clientId, CALLBACK), CALLBACK, error);
  });

  it("the open-redirect case: a link built from an attacker's own registration never bounces off this server", async () => {
    const clientId = await register([ATTACKER], { client_name: 'Claude' });
    for (const res of [
      await request(app).get('/authorize').query({ client_id: clientId, response_type: 'token', redirect_uri: ATTACKER }),
      await request(app).get('/authorize').query({ client_id: clientId, response_type: 'code' }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.headers['location']).toBeUndefined();
      expect(res.headers['refresh']).toBeUndefined();
      expect(res.text).toContain('return to attacker.example');
    }
  });

  it("Claude's callback is verified by default", async () => {
    const clientId = await register([CLAUDE_CALLBACK]);
    expectErrorRedirect(await authorize(clientId, CLAUDE_CALLBACK, { response_type: 'token' }), CLAUDE_CALLBACK, 'invalid_request');
  });

  it('loopback is trusted for redirects by default, and not when MCP_TRUST_LOOPBACK_REDIRECTS=false', async () => {
    const clientId = await register([LOOPBACK]);
    expectErrorRedirect(await authorize(clientId, LOOPBACK, { response_type: 'token' }), LOOPBACK, 'invalid_request');
    const strict = await createHttpApp(makeConfig({ trustLoopbackRedirects: false }));
    const strictId = await register([LOOPBACK], {}, strict);
    expectErrorPage(await authorize(strictId, LOOPBACK, { response_type: 'token' }, strict), 'invalid_request');
  });

  it('with an empty verified list nothing is redirected', async () => {
    const empty = await createHttpApp(makeConfig({ verifiedRedirectUris: [], trustLoopbackRedirects: false }));
    const clientId = await register([CLAUDE_CALLBACK], {}, empty);
    expectErrorPage(await authorize(clientId, CLAUDE_CALLBACK, { response_type: 'token' }, empty), 'invalid_request');
  });
});

describe('consent page (55a)', () => {
  it('names the host prominently and calls an unverified client "calls itself"; strict headers', async () => {
    const clientId = await register([ATTACKER], { client_name: 'Claude' });
    const res = await authorize(clientId, ATTACKER);
    expect(res.status).toBe(200);
    expect(res.text).toContain('An application at <strong>attacker.example</strong> that calls itself <strong>“Claude”</strong>');
    expect(res.text).toContain('you will be returned to <strong>attacker.example</strong>');
    expect(res.headers['content-security-policy']).toBe(PAGE_CSP);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('names a verified client plainly', async () => {
    const clientId = await register([CLAUDE_CALLBACK], { client_name: 'Claude' });
    const res = await authorize(clientId, CLAUDE_CALLBACK);
    expect(res.text).toContain('<p><strong>Claude</strong> is requesting access');
    expect(res.text).not.toContain('calls itself');
    expect(res.text).toContain('returned to <strong>claude.ai</strong>');
  });

  it('labels a loopback client although its errors redirect', async () => {
    const clientId = await register([LOOPBACK], { client_name: 'CLI' });
    const res = await authorize(clientId, LOOPBACK);
    expect(res.text).toContain('calls itself <strong>“CLI”</strong>');
    expect(res.text).toContain('This address is on your own device.');
    expect(res.text).toContain('returned to <strong>localhost:33418</strong>');
  });

  it('strips bidi and zero-width characters from a name stored under older rules', async () => {
    const clientId = await plant({ redirect_uris: [CALLBACK], client_name: 'Cla‮ude​⁦ Desktop' });
    const res = await authorize(clientId, CALLBACK);
    expect(res.status).toBe(200);
    expect(res.text).toContain('“Claude Desktop”');
    expect(res.text).not.toMatch(/[‮​⁦]/);
  });

  it('shows an internationalized host in its punycode form', async () => {
    const clientId = await register(['https://аррӏе.com/cb'], { client_name: 'Apple' });
    const res = await authorize(clientId, 'https://аррӏе.com/cb');
    expect(res.status).toBe(200);
    expect(res.text).toContain('An application at <strong>xn--80ak6aa92e.com</strong> that calls itself');
  });
});
