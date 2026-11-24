/**
 * #55 end to end over HTTP, with oidc-provider mounted (#47-4): dynamic
 * client registration rules (dcr-validator), /authorize bounds and the
 * grandfathered-client refusal (authorize-validation), the open-redirect
 * guard over every error the library would redirect once it has accepted the
 * client and the redirect URI (authorize-guard's pre-validation and its
 * redirect net), and the consent page (the library's interaction, which
 * /authorize sends the browser to with a 303). Only the YNAB network calls
 * are absent (nothing here reaches them).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
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
import { MAX_CLIENT_ID_LENGTH, MAX_SCOPES, MAX_STATE_LENGTH } from '../../src/auth/authorize-validation.js';
import { PAGE_CSP } from '../../src/auth/auth-pages.js';
import { plainRowKey } from '../../src/storage/oauth-rows.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { plantClient, registerTestClient, storedClient } from './helpers/oauth-state.js';
import { CookieJar, browse, interactionUid } from './helpers/oidc-app.js';
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
    // The shared test pepper, so this file can find the interaction a request created.
    tokenPepper: TEST_TOKEN_PEPPER,
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
  const res = await registerTestClient(on, {
    redirect_uris: redirectUris,
    client_name: 'Test App',
    token_endpoint_auth_method: 'none',
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body['client_id'] as string;
}

/** A client saved straight to storage, as an older release could have registered it. */
async function plant(client: Record<string, unknown>): Promise<string> {
  const clientId = randomUUID();
  // A public client, as a 0.4.x DCR client without a secret was stored (method `none`).
  await plantClient(storage(), { client_id: clientId, client_id_issued_at: 1, token_endpoint_auth_method: 'none', ...client });
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
    // Clients registered on 0.5.0 must name the resource (#64a).
    resource: `${PUBLIC_URL}/mcp`,
    ...extra,
  };
}

/** The interaction a 303 from /authorize names (the consent page), or undefined for any other answer. */
function interactionOf(res: request.Response): string | undefined {
  const location = res.headers['location'] as string | undefined;
  if (res.status !== 303 || location === undefined) return undefined;
  return new URL(location, PUBLIC_URL).pathname.startsWith('/oauth/interaction/') ? location : undefined;
}

/**
 * Follow a 303 from /authorize to the consent page, as the browser would
 * (with the library's interaction cookie); any other answer is returned as is.
 */
async function follow(res: request.Response, on: Express = app): Promise<request.Response> {
  const location = interactionOf(res);
  if (location === undefined) return res;
  const jar = new CookieJar();
  jar.take(res);
  return browse(on, jar, location);
}

/** GET /authorize, following a 303 to the consent page. */
const authorize = async (clientId: string, redirectUri: string, extra: Record<string, unknown> = {}, on: Express = app) =>
  follow(await request(on).get('/authorize').query(authorizeQuery(clientId, redirectUri, extra)), on);

/** GET a raw /authorize path (repeated parameters), following a 303 to the consent page. */
const authorizeRaw = async (path: string, on: Express = app) => follow(await request(on).get(path), on);

/** The scope the library holds for the interaction a 303 from /authorize names (D7 has normalized it). */
async function interactionScope(res: request.Response): Promise<unknown> {
  const location = interactionOf(res);
  if (location === undefined) throw new Error(`not a redirect to the consent page: ${res.status}`);
  const key = TEST_TOKEN_HASHER.libraryStorageKey('interaction', interactionUid(location)) as string;
  const row = await storage().findOAuthRow(key);
  return (JSON.parse(row?.payload ?? '{}') as { params?: { scope?: unknown } }).params?.scope;
}

/** Whether `run` created an interaction (the library got past every check of the request). */
async function interactionsDuring(run: () => Promise<unknown>): Promise<number> {
  const upsert = vi.spyOn(storage(), 'upsertOAuthRow');
  try {
    await run();
    return upsert.mock.calls.filter(([row]) => row.model === 'Interaction').length;
  } finally {
    upsert.mockRestore();
  }
}

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
    const stored = await storedClient(storage(), res.body.client_id as string);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain('attacker.example');
  });

  it('refuses sector_identifier_uri (the library would fetch it) with invalid_client_metadata, before the library', async () => {
    const res = await request(app)
      .post('/register')
      .set('Origin', 'https://inspector.example')
      .send({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', sector_identifier_uri: 'https://attacker.example/s.json' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_client_metadata', error_description: 'sector_identifier_uri is not supported' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['six redirect URIs', { redirect_uris: Array.from({ length: 6 }, (_, i) => `${CALLBACK}${i}`) }, 'invalid_client_metadata'],
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

});

describe('/authorize bounds (55a)', () => {
  it(`state: ${MAX_STATE_LENGTH} characters pass; more, or more than one, is invalid_request, never echoed`, async () => {
    const clientId = await register([CALLBACK]);
    expect((await authorize(clientId, CALLBACK, { state: 's'.repeat(MAX_STATE_LENGTH) })).status).toBe(200);
    const long = 's'.repeat(MAX_STATE_LENGTH + 1);
    const res = await authorize(clientId, CALLBACK, { state: long });
    expect(refused(res, 'invalid_request').has('state')).toBe(false);
    expect(res.text).not.toContain(long);
    const twice = await authorizeRaw(
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

  it('unknown scopes are dropped before the library (batch-3 default; D7 normalizes the rest)', async () => {
    const writable = await createHttpApp(makeConfig({ readOnly: false }));
    const clientId = await register([CALLBACK], {}, writable);
    const send = (scope: string) => request(writable).get('/authorize').query(authorizeQuery(clientId, CALLBACK, { scope }));

    const readOnly = await send('openid read-only profile read-only');
    expect(await interactionScope(readOnly)).toBe('read-only');
    const page = await follow(readOnly, writable);
    expect(page.status).toBe(200);
    // Only read-only was asked for, so read-write isn't offered.
    expect(page.text).not.toContain('scope=read-write');

    // Nothing known asked for: D7 asks for both levels, as no scope at all does.
    const onlyUnknown = await send('openid offline_access');
    expect(await interactionScope(onlyUnknown)).toBe('read-only read-write');
    expect((await follow(onlyUnknown, writable)).text).toContain('scope=read-write');
  });

  it('POST /authorize is not served: 405 from method-check, before any bound or lookup', async () => {
    const clientId = await register([CALLBACK]);
    const lookup = vi.spyOn(storage(), 'findOAuthRow');
    const res = await request(app)
      .post('/authorize')
      .type('form')
      .send(authorizeQuery(clientId, CALLBACK, { state: 'x'.repeat(MAX_STATE_LENGTH + 1) }));
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
    expect(res.headers['location']).toBeUndefined();
    expect(res.body.error).toBe('method_not_allowed');
    expect(lookup).not.toHaveBeenCalled();
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

  describe('client_id: an invalid one never reaches the client store', () => {
    const overlong = 'a'.repeat(MAX_CLIENT_ID_LENGTH + 1);
    // The rest of a valid authorization request, so only client_id is wrong.
    const rest = { response_type: 'code', redirect_uri: CALLBACK, code_challenge: CHALLENGE, code_challenge_method: 'S256' };
    const qs = new URLSearchParams(rest).toString();
    const SHAPES: ReadonlyArray<{ name: string; error: string; send: () => request.Test }> = [
      { name: 'GET missing', error: 'invalid_request', send: () => request(app).get(`/authorize?${qs}`) },
      { name: 'GET empty', error: 'invalid_client', send: () => request(app).get(`/authorize?${qs}&client_id=`) },
      { name: 'GET overlong', error: 'invalid_client', send: () => request(app).get(`/authorize?${qs}&client_id=${overlong}`) },
      { name: 'GET repeated', error: 'invalid_request', send: () => request(app).get(`/authorize?${qs}&client_id=a&client_id=b`) },
    ];

    /** The client lookups `run` makes (reads of a `Client` row). */
    async function clientLookups(run: () => Promise<unknown>): Promise<string[]> {
      const find = vi.spyOn(storage(), 'findOAuthRow');
      try {
        await run();
        return find.mock.calls.map(([key]) => key).filter((key) => key.startsWith(plainRowKey('Client', '')));
      } finally {
        find.mockRestore();
      }
    }

    it.each(SHAPES)('$name: the SDK-handler-shaped 400, with no client lookup', async ({ error, send }) => {
      let res: request.Response | undefined;
      const lookups = await clientLookups(async () => {
        res = await send();
      });
      expect(res?.status).toBe(400);
      expect(res?.headers['cache-control']).toBe('no-store');
      expect(res?.headers['location']).toBeUndefined();
      expect(res?.body.error).toBe(error);
      if (error === 'invalid_client') expect(res?.body.error_description).toBe('Invalid client_id');
      expect(lookups).toEqual([]);
    });

    it('a valid client_id is looked up by the stage and by the library; an unknown one gets the library 400', async () => {
      const clientId = await register([CALLBACK]);
      const key = plainRowKey('Client', clientId);
      let res: request.Response | undefined;
      expect(await clientLookups(async () => (res = await request(app).get('/authorize').query(authorizeQuery(clientId, CALLBACK))))).toEqual([key, key]);
      expect(interactionOf(res as request.Response)).toBeDefined();

      const id = 'b'.repeat(MAX_CLIENT_ID_LENGTH);
      const lookups = await clientLookups(async () => (res = await authorize(id, CALLBACK)));
      expect(res?.status).toBe(400);
      expect(res?.headers['location']).toBeUndefined();
      expect(res?.body.error).toBe('invalid_client');
      expect(new Set(lookups)).toEqual(new Set([plainRowKey('Client', id)]));
    });
  });

  it('a storage failure looking up the client is a generic 500, never a redirect', async () => {
    const clientId = await register([CALLBACK]);
    vi.spyOn(storage(), 'findOAuthRow').mockRejectedValueOnce(new Error('connect ECONNREFUSED db.internal:5432'));
    const res = await authorize(clientId, CALLBACK);
    expect(res.status).toBe(500);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).toEqual({ error: 'server_error', error_description: 'Internal Server Error' });
    expect(res.text).not.toContain('db.internal');
  });

  describe('redirect_uri matching (exact, except an http loopback port)', () => {
    const REG = 'http://127.0.0.1:1234/cb';

    it.each([
      ['a fragment', 'http://127.0.0.1:1234/cb#extra'],
      ['userinfo', 'http://user@127.0.0.1:1234/cb'],
      ['a different path', 'http://127.0.0.1:1234/other'],
      ['a different query', 'http://127.0.0.1:1234/cb?x=1'],
      // Compared as written, not after URL parsing (which would make these equal).
      ['dot segments', 'http://127.0.0.1:1234/a/../cb'],
      ['dot segments on another port', 'http://127.0.0.1:5555/x/../cb'],
      ['an encoded dot segment', 'http://127.0.0.1:5555/x/%2e%2e/cb'],
      ['a percent-encoded path', 'http://127.0.0.1:5555/c%62'],
      ['another case in the path', 'http://127.0.0.1:1234/CB'],
      ['an IPv4 shorthand for the host', 'http://127.1:5555/cb'],
    ])('refuses %s with a direct 400 before the library', async (_name, requested) => {
      const clientId = await register([REG]);
      let res: request.Response | undefined;
      expect(await interactionsDuring(async () => (res = await authorize(clientId, requested)))).toBe(0);
      expect(res?.status).toBe(400);
      expect(res?.headers['location']).toBeUndefined();
      expect(res?.body).toEqual({ error: 'invalid_request', error_description: 'Unregistered redirect_uri' });
    });

    it('refuses an https loopback redirect URI on another port', async () => {
      const clientId = await register(['https://localhost:1234/cb']);
      const res = await authorize(clientId, 'https://localhost:5555/cb');
      expect(res.status).toBe(400);
      expect(res.body.error_description).toBe('Unregistered redirect_uri');
    });

    it('accepts an http loopback redirect URI on another port', async () => {
      const clientId = await register([REG]);
      const res = await authorize(clientId, 'http://127.0.0.1:5555/cb');
      expect(res.status).toBe(200);
      expect(res.text).toContain('returned to <strong>127.0.0.1:5555</strong>');
    });

    it('keeps the port exception for localhost and [::1]', async () => {
      const clientId = await register(['http://localhost:1234/cb?x=1', 'http://[::1]:1234/cb']);
      expect((await authorize(clientId, 'http://localhost:5555/cb?x=1')).status).toBe(200);
      expect((await authorize(clientId, 'http://[::1]:5555/cb')).status).toBe(200);
    });

    /** The request's parameters without redirect_uri: the handler then uses the only registered one. */
    const implicitQuery = (clientId: string): Record<string, unknown> => {
      const { redirect_uri: _omitted, ...rest } = authorizeQuery(clientId, CALLBACK);
      return rest;
    };

    // A stored redirect URI with a fragment fails the library's client schema
    // (M4 drops such 0.4.x clients): our stages read it as unknown, and the
    // library refuses it with its own 400 `invalid_redirect_uri`, never a
    // redirect.
    it.each([
      ['an https URI', 'https://client.example/cb#frag'],
      ['a loopback URI', 'http://127.0.0.1:1234/cb#frag'],
      ['an empty fragment', 'https://client.example/cb#'],
    ])('refuses a stored redirect URI with a fragment (%s) when the request names it, with a direct 400', async (_name, uri) => {
      const clientId = await plant({ redirect_uris: [uri] });
      let res: request.Response | undefined;
      expect(await interactionsDuring(async () => (res = await authorize(clientId, uri)))).toBe(0);
      expect(res?.status).toBe(400);
      expect(res?.headers['location']).toBeUndefined();
      expect(res?.body).toEqual({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must not contain fragments' });
    });

    it.each([
      ['an https URI', 'https://client.example/cb#frag'],
      ['a loopback URI', 'http://127.0.0.1:1234/cb#frag'],
    ])('refuses the only stored redirect URI when it has a fragment (%s) and none is requested, with a direct 400', async (_name, uri) => {
      const clientId = await plant({ redirect_uris: [uri] });
      let res: request.Response | undefined;
      expect(
        await interactionsDuring(async () => (res = await request(app).get('/authorize').query(implicitQuery(clientId))))
      ).toBe(0);
      expect(res?.status).toBe(400);
      expect(res?.headers['location']).toBeUndefined();
      expect(res?.headers['cache-control']).toBe('no-store');
      expect(res?.body).toEqual({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must not contain fragments' });
    });

    it('still uses the only registered redirect URI when none is requested', async () => {
      const clientId = await register([CALLBACK]);
      const res = await follow(await request(app).get('/authorize').query(implicitQuery(clientId)));
      expect(res.status).toBe(200);
      expect(res.text).toContain('returned to <strong>client.example</strong>');
    });
  });

  it('answers an unknown client and an unregistered redirect URI with a 400 JSON, never a redirect', async () => {
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
    // Only the stored client's own failures: not the fields the library fills in by default.
    expect(logged[0]).toContain('redirect_uris count; client_name; unsupported fields: logo_uri.');
    expect(logged[0]).not.toContain('client.example');
  });

  it('logs nothing for a client registered today (the library-default fields are not "older rules")', async () => {
    const clientId = await register([CALLBACK]);
    expect((await authorize(clientId, CALLBACK)).status).toBe(200);
    expect(warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes(clientId))).toEqual([]);
  });

  it('accepts a stored loopback-http client (native, as M4 converts one)', async () => {
    const clientId = await plant({ redirect_uris: ['http://127.0.0.1/cb'], application_type: 'native' });
    expect((await authorize(clientId, 'http://127.0.0.1:5000/cb')).status).toBe(200);
  });
});

/**
 * Every error oidc-provider would redirect to the client once it has accepted
 * the client and the redirect URI (its /authorize stack, see
 * authorize-guard.ts). authorize-guard answers each one before the library
 * runs: for an unverified client our page, for a verified one a redirect.
 */
const PHASE2: ReadonlyArray<{ name: string; error: string; send: (on: Express, clientId: string, uri: string) => request.Test }> = [
  {
    name: 'response_type other than code',
    error: 'unsupported_response_type',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { response_type: 'token' })),
  },
  {
    name: 'response_type missing',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { response_type: undefined })),
  },
  {
    name: 'code_challenge_method plain',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { code_challenge_method: 'plain' })),
  },
  {
    name: 'a repeated parameter',
    error: 'invalid_request',
    send: (on, id, uri) =>
      request(on).get(`/authorize?${new URLSearchParams(authorizeQuery(id, uri) as Record<string, string>).toString()}&response_type=code`),
  },
  {
    name: 'a request object (request_uri)',
    error: 'request_uri_not_supported',
    send: (on, id, uri) =>
      request(on).get('/authorize').query(authorizeQuery(id, uri, { request_uri: 'https://attacker.example/req' })),
  },
  {
    name: 'prompt=none (every authorization needs the consent page and YNAB)',
    error: 'login_required',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { prompt: 'none' })),
  },
  {
    name: 'an unsupported prompt value',
    error: 'invalid_request',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { prompt: 'select_account' })),
  },
  {
    name: 'a resource that is not a URL',
    error: 'invalid_target',
    send: (on, id, uri) => request(on).get('/authorize').query(authorizeQuery(id, uri, { resource: 'not a url' })),
  },
  {
    name: 'a foreign resource (invalid_target)',
    error: 'invalid_target',
    send: (on, id, uri) =>
      request(on).get('/authorize').query(authorizeQuery(id, uri, { resource: 'https://evil.example/mcp' })),
  },
];

describe('authorize-guard: every error the library would redirect (55b)', () => {
  it.each(PHASE2)('unverified client, $name: our page, not a redirect, and the library never runs', async ({ error, send }) => {
    const clientId = await register([CALLBACK]);
    let res: request.Response | undefined;
    expect(await interactionsDuring(async () => (res = await send(app, clientId, CALLBACK)))).toBe(0);
    expectErrorPage(res as request.Response, error);
    res = res as request.Response;
    expect(res.text).not.toContain('db.internal');
    // The user may go back on their own: the link is the error response the client would have got.
    const link = returnLink(res);
    expect(link?.origin + (link?.pathname ?? '')).toBe(CALLBACK);
    expect(link?.searchParams.get('error')).toBe(error);
    expect(link?.searchParams.get('iss')).toBe(ISSUER);
    expect(res.text).toContain('return to client.example');
  });

  it.each(PHASE2)('verified client, $name: an RFC 6749 redirect with iss and state', async ({ error, send }) => {
    const verified = await createHttpApp(makeConfig({ verifiedRedirectUris: [CALLBACK] }));
    const clientId = await register([CALLBACK], {}, verified);
    const loc = expectErrorRedirect(await send(verified, clientId, CALLBACK), CALLBACK, error);
    expect(loc.searchParams.get('state')).toBe('client-state');
  });

  it('a storage failure while the library starts the interaction is a generic 500, never a redirect (verified or not)', async () => {
    for (const make of [async () => app, () => createHttpApp(makeConfig({ verifiedRedirectUris: [CALLBACK] }))]) {
      // storage() is the newest app's: the verified one is built just before its turn.
      const on = await make();
      const clientId = await register([CALLBACK], {}, on);
      vi.spyOn(storage(), 'upsertOAuthRow').mockRejectedValueOnce(new Error('connect ECONNREFUSED db.internal:5432'));
      const res = await request(on).get('/authorize').query(authorizeQuery(clientId, CALLBACK));
      expect(res.status).toBe(500);
      expect(res.headers['location']).toBeUndefined();
      expect(res.body.error).toBe('server_error');
      expect(res.text).not.toContain('db.internal');
    }
  });

  it('response_mode is ignored (as the SDK did): the answer is never a page that posts to the client', async () => {
    const clientId = await register([CALLBACK]);
    // An error, with form_post asked for: still our page, never an auto-submitting form.
    const error = await request(app).get('/authorize').query(authorizeQuery(clientId, CALLBACK, { response_mode: 'form_post', prompt: 'none' }));
    expectErrorPage(error, 'login_required');
    expect(error.text).not.toContain('<form');
    // A good request with form_post asked for: the consent page as usual.
    const good = await authorize(clientId, CALLBACK, { response_mode: 'form_post' });
    expect(good.status).toBe(200);
    expect(good.text).toContain('scope=read-only');
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
    expectErrorRedirect(await authorize(clientId, CLAUDE_CALLBACK, { response_type: 'token' }), CLAUDE_CALLBACK, 'unsupported_response_type');
  });

  it('loopback is trusted for redirects by default, and not when MCP_TRUST_LOOPBACK_REDIRECTS=false', async () => {
    const clientId = await register([LOOPBACK]);
    expectErrorRedirect(await authorize(clientId, LOOPBACK, { response_type: 'token' }), LOOPBACK, 'unsupported_response_type');
    const strict = await createHttpApp(makeConfig({ trustLoopbackRedirects: false }));
    const strictId = await register([LOOPBACK], {}, strict);
    expectErrorPage(await authorize(strictId, LOOPBACK, { response_type: 'token' }, strict), 'unsupported_response_type');
  });

  it('with an empty verified list nothing is redirected', async () => {
    const empty = await createHttpApp(makeConfig({ verifiedRedirectUris: [], trustLoopbackRedirects: false }));
    const clientId = await register([CLAUDE_CALLBACK], {}, empty);
    expectErrorPage(await authorize(clientId, CLAUDE_CALLBACK, { response_type: 'token' }, empty), 'unsupported_response_type');
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
