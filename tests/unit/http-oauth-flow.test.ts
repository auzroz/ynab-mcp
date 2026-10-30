/**
 * The whole remote flow end to end in oauth mode, through the real Express app,
 * the SDK's auth handlers, the provider, the session manager and the real tool
 * handlers: discovery, dynamic registration, authorization with PKCE and a
 * resource indicator, the YNAB federation legs, token exchange, an MCP session
 * (initialize, tools/list, tools/call), a YNAB token refresh under a live
 * session, refresh-token rotation and session teardown.
 *
 * Only YNAB's external endpoints are mocked: the OAuth functions (code
 * exchange, user id, refresh) and global fetch for the YNAB REST API. The clock
 * is the one fake: only Date is faked, so expiry is a jump forward and no
 * timer is left running.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

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

// Keeps a handle on the storage the app creates, so a test can plant a token
// the authorization server itself would refuse to issue.
const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { exchangeCode, getYnabUserId, refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { tools } from '../../src/tools/index.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { cookieHeaderFrom } from './helpers/consent-cookie.js';

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
const METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
const CALLBACK = 'https://client.example/cb';
const YNAB_CALLBACK = `${PUBLIC_URL}/oauth/ynab/callback`;
const ACCEPT = 'application/json, text/event-stream';

const READ_TOOLS = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
const ALL_TOOLS = tools.map((t) => t.name);

const fetchMock = vi.fn<typeof fetch>();
let handle: HttpApp;
let app: Express;
let ynabUserId: string;
let ynabRefreshes: number;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['Date'] });

  // Each YNAB refresh returns a new access token and rotates the refresh token.
  ynabRefreshes = 0;
  ynabUserId = 'ynab-user-rw';
  vi.mocked(exchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-0',
    refreshToken: 'ynab-refresh-0',
    expiresAt: Date.now() + 7200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockImplementation(async () => ynabUserId);
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => {
    ynabRefreshes++;
    return {
      accessToken: `ynab-access-${ynabRefreshes}`,
      refreshToken: `ynab-refresh-${ynabRefreshes}`,
      expiresAt: Date.now() + 7200_000,
    };
  });

  fetchMock.mockReset().mockImplementation(async () =>
    new Response(
      JSON.stringify({
        data: { plans: [{ id: 'plan-1', name: 'Household', last_modified_on: '2026-01-01T00:00:00Z' }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  vi.stubGlobal('fetch', fetchMock);

  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      readOnly: false,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey: randomBytes(32).toString('base64'),
      // Longer than the clock jump below, so only the YNAB token expires.
      accessTokenTtlSec: 24 * 3600,
      sessionIdleTimeoutMs: 24 * 3600_000,
    })
  );
  app = handle.app;
});

afterEach(async () => {
  await handle.sessions.close();
  await created.storage?.close();
  created.storage = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- OAuth client side -----------------------------------------------------

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [CALLBACK], client_name: 'flow-test', token_endpoint_auth_method: 'none' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** The consent page's links, by the access level they choose. */
function consentLinks(html: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const m of html.matchAll(/<a class="btn" href="([^"]+)"/g)) {
    const url = new URL((m[1] as string).replaceAll('&amp;', '&'));
    links.set(url.searchParams.get('scope') as string, url.pathname + url.search);
  }
  return links;
}

interface Authorized {
  clientId: string;
  verifier: string;
  code: string;
}

/**
 * /authorize through the consent page and the YNAB legs to the MCP code,
 * asserting each hop. `choose` is the access level picked on the consent page.
 */
async function authorize(choose: 'read-only' | 'read-write', scope: string): Promise<Authorized> {
  const clientId = await register();
  const { verifier, challenge } = pkce();

  const consent = await request(app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    state: 'client-state',
    resource: RESOURCE,
  });
  expect(consent.status).toBe(200);
  const cookie = cookieHeaderFrom(consent);
  const links = consentLinks(consent.text);
  const start = links.get(choose);
  if (start === undefined) throw new Error(`consent page does not offer ${choose}`);

  // The consent link sends the browser to YNAB, carrying our pending-auth state.
  const toYnab = await request(app).get(start).set('Cookie', cookie);
  expect(toYnab.status).toBe(302);
  const ynabUrl = new URL(toYnab.headers['location'] as string);
  expect(ynabUrl.origin + ynabUrl.pathname).toBe('https://app.ynab.com/oauth/authorize');
  expect(ynabUrl.searchParams.get('client_id')).toBe('ynab-client-id');
  expect(ynabUrl.searchParams.get('redirect_uri')).toBe(YNAB_CALLBACK);
  expect(ynabUrl.searchParams.get('response_type')).toBe('code');
  expect(ynabUrl.searchParams.get('scope')).toBe(choose === 'read-only' ? 'read-only' : null);
  const state = ynabUrl.searchParams.get('state');
  expect(state).toBeTruthy();
  expect(new URL(start, PUBLIC_URL).searchParams.get('state')).toBe(state);

  // YNAB redirects the browser back with its code.
  const callback = await request(app)
    .get('/oauth/ynab/callback')
    .set('Cookie', cookie)
    .query({ code: 'ynab-code', state: state as string });
  expect(callback.status).toBe(302);
  expect(vi.mocked(exchangeCode).mock.calls.at(-1)?.[1]).toEqual({
    code: 'ynab-code',
    redirectUri: YNAB_CALLBACK,
  });

  // Back to the MCP client: code, its own state, and the issuer (RFC 9207).
  const back = new URL(callback.headers['location'] as string);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  expect(back.searchParams.get('state')).toBe('client-state');
  expect(back.searchParams.get('iss')).toBe(`${PUBLIC_URL}/`);
  const code = back.searchParams.get('code');
  if (!code) throw new Error('no authorization code');
  // The cookie was for this one authorization; the callback clears it.
  expect(String(callback.headers['set-cookie'])).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

  return { clientId, verifier, code };
}

function tokenRequest(form: Record<string, string>): request.Test {
  return request(app).post('/token').type('form').send(form);
}

interface Tokens {
  clientId: string;
  access: string;
  refresh: string;
  scope: string;
}

async function exchange({ clientId, verifier, code }: Authorized): Promise<Tokens> {
  const res = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
    resource: RESOURCE,
  });
  expect(res.status).toBe(200);
  expect(res.body.token_type.toLowerCase()).toBe('bearer');
  expect(res.body.expires_in).toBe(24 * 3600);
  return {
    clientId,
    access: res.body.access_token as string,
    refresh: res.body.refresh_token as string,
    scope: res.body.scope as string,
  };
}

async function connect(
  choose: 'read-only' | 'read-write',
  scope = 'read-only read-write'
): Promise<Tokens> {
  return exchange(await authorize(choose, scope));
}

// ---- MCP client side -------------------------------------------------------

/** The JSON-RPC message in a response, whether sent as JSON or as one SSE event. */
function rpcMessage(res: request.Response): Record<string, any> {
  if (res.body && typeof res.body === 'object' && 'jsonrpc' in res.body) return res.body;
  const data = res.text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .at(-1);
  if (!data) throw new Error(`no JSON-RPC message in response (status ${res.status})`);
  return JSON.parse(data) as Record<string, any>;
}

function mcp(
  method: 'post' | 'delete',
  accessToken: string,
  sessionId?: string
): request.Test {
  let req = request(app)[method]('/mcp').set('Authorization', `Bearer ${accessToken}`).set('Accept', ACCEPT);
  if (sessionId !== undefined) req = req.set('mcp-session-id', sessionId).set('mcp-protocol-version', '2025-06-18');
  return req;
}

async function initialize(accessToken: string): Promise<string> {
  const res = await mcp('post', accessToken).send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'flow-test', version: '0.0.0' },
    },
  });
  expect(res.status).toBe(200);
  // The version, not the name: a rename of serverInfo must not break this flow test.
  expect(rpcMessage(res)['result']['serverInfo']['version']).toBe(pkg.version);
  const sessionId = res.headers['mcp-session-id'] as string;
  expect(sessionId).toBeTruthy();
  const ack = await mcp('post', accessToken, sessionId).send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  expect(ack.status).toBe(202);
  return sessionId;
}

async function listTools(accessToken: string, sessionId: string): Promise<string[]> {
  const res = await mcp('post', accessToken, sessionId).send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  expect(res.status).toBe(200);
  return (rpcMessage(res)['result']['tools'] as Array<{ name: string }>).map((t) => t.name);
}

async function callTool(
  accessToken: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string }> {
  const res = await mcp('post', accessToken, sessionId).send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  const result = rpcMessage(res)['result'];
  return { isError: result['isError'] === true, text: result['content'][0]['text'] as string };
}

/** The bearer token each YNAB REST call carried, in order. */
function ynabApiBearers(): (string | null)[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
}

// ---- The flow --------------------------------------------------------------

describe('OAuth + MCP flow (oauth mode, memory storage)', () => {
  it('connects a client, serves a session across a YNAB token expiry, rotates tokens and ends the session', async () => {
    // Discovery: an unauthenticated client is pointed at the resource metadata
    // (RFC 9728), which names the authorization server, whose metadata names
    // the endpoints it will use.
    const challenge = await request(app).post('/mcp').set('Accept', ACCEPT).send({});
    expect(challenge.status).toBe(401);
    expect(challenge.headers['www-authenticate']).toContain(`resource_metadata="${METADATA_URL}"`);

    const prm = await request(app).get(new URL(METADATA_URL).pathname);
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toBe(RESOURCE);
    expect(prm.body.authorization_servers).toEqual([`${PUBLIC_URL}/`]);

    const as = await request(app).get('/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    expect(as.body.issuer).toBe(prm.body.authorization_servers[0]);
    expect(as.body.authorization_endpoint).toBe(`${PUBLIC_URL}/authorize`);
    expect(as.body.token_endpoint).toBe(`${PUBLIC_URL}/token`);
    expect(as.body.registration_endpoint).toBe(`${PUBLIC_URL}/register`);
    expect(as.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.body.authorization_response_iss_parameter_supported).toBe(true);

    // Register, authorize (PKCE S256, resource), consent, YNAB, and exchange the code.
    const grant = await authorize('read-write', 'read-only read-write');
    expect(vi.mocked(getYnabUserId)).toHaveBeenCalledWith('ynab-access-0', undefined);
    const tokens = await exchange(grant);
    expect(tokens.scope).toBe('read-only read-write');

    // The code is single use.
    const replayedCode = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: grant.clientId,
      code: grant.code,
      code_verifier: grant.verifier,
      redirect_uri: CALLBACK,
    });
    expect(replayedCode.status).toBe(400);
    expect(replayedCode.body.error).toBe('invalid_grant');

    // A read-write grant sees every tool.
    const sessionId = await initialize(tokens.access);
    expect(await listTools(tokens.access, sessionId)).toEqual(ALL_TOOLS);
    expect(handle.sessions.size).toBe(1);

    // A read tool reaches YNAB with the user's access token. The token from the
    // code exchange is not cached, so the first call refreshes (ynab-access-1);
    // this pins today's behaviour, not a requirement.
    const first = await callTool(tokens.access, sessionId, 'ynab_list_budgets');
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text).budgets).toEqual([expect.objectContaining({ id: 'plan-1', name: 'Household' })]);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/plans']);
    expect(ynabApiBearers()).toEqual(['Bearer ynab-access-1']);

    // The YNAB token (2h) expires while the session lives on. The next call
    // refreshes with the rotated refresh token, and uses the new access token.
    vi.setSystemTime(Date.now() + 3 * 3600_000);
    const second = await callTool(tokens.access, sessionId, 'ynab_list_budgets');
    expect(second.isError).toBe(false);
    expect(ynabRefreshes).toBe(2);
    expect(vi.mocked(refreshAccessToken).mock.calls.map(([, refreshToken]) => refreshToken)).toEqual([
      'ynab-refresh-0',
      'ynab-refresh-1',
    ]);
    expect(ynabApiBearers()).toEqual(['Bearer ynab-access-1', 'Bearer ynab-access-2']);

    // MCP refresh-token rotation: the new pair works on the same session (same
    // client, user and access level), the old refresh token is spent.
    const refreshed = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: tokens.refresh,
      resource: RESOURCE,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(tokens.access);
    expect(refreshed.body.refresh_token).not.toBe(tokens.refresh);
    expect(await listTools(refreshed.body.access_token, sessionId)).toEqual(ALL_TOOLS);

    // DELETE ends the session; its id is then unknown (404), so the client re-initializes.
    const del = await mcp('delete', refreshed.body.access_token, sessionId);
    expect(del.status).toBe(200);
    expect(handle.sessions.size).toBe(0);
    const after = await mcp('post', refreshed.body.access_token, sessionId).send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {},
    });
    expect(after.status).toBe(404);
    expect((await mcp('delete', refreshed.body.access_token, sessionId)).status).toBe(404);

    // Replaying the spent refresh token is reuse (RFC 9700 section 4.14.2): it
    // fails like an unknown token and revokes the whole family, so the rotated
    // pair stops working too.
    const replayedRefresh = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: tokens.refresh,
    });
    expect(replayedRefresh.status).toBe(400);
    expect(replayedRefresh.body.error).toBe('invalid_grant');
    expect(replayedRefresh.body.access_token).toBeUndefined();
    expect((await mcp('delete', refreshed.body.access_token, sessionId)).status).toBe(401);
    const revokedRefresh = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: refreshed.body.refresh_token,
    });
    expect(revokedRefresh.status).toBe(400);
    expect(revokedRefresh.body).toEqual(replayedRefresh.body);
  });

  it('a read-only grant lists and runs only read tools, and a refresh cannot widen it', async () => {
    ynabUserId = 'ynab-user-ro';
    // Only read-only is offered to a client that asks for only read-only.
    const grant = await authorize('read-only', 'read-only');
    const tokens = await exchange(grant);
    expect(tokens.scope).toBe('read-only');

    const sessionId = await initialize(tokens.access);
    const listed = await listTools(tokens.access, sessionId);
    expect(listed).toEqual(READ_TOOLS);
    expect(listed.length).toBeLessThan(ALL_TOOLS.length);

    // Hidden also means refused by name, without reaching YNAB.
    const write = await callTool(tokens.access, sessionId, 'ynab_create_category_group', {
      budget_id: 'plan-1',
      name: 'Sneaky',
    });
    expect(write.isError).toBe(true);
    expect(JSON.parse(write.text).type).toBe('read_only_mode');
    expect(fetchMock).not.toHaveBeenCalled();

    const widen = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: tokens.refresh,
      scope: 'read-only read-write',
    });
    expect(widen.status).toBe(400);
    expect(widen.body.error).toBe('invalid_scope');
    expect(widen.body.access_token).toBeUndefined();

    // The refusal did not spend the refresh token: a plain refresh still works,
    // and stays read-only.
    const refreshed = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: tokens.refresh,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.scope).toBe('read-only');
    expect(await listTools(refreshed.body.access_token, sessionId)).toEqual(READ_TOOLS);
  });

  it('a grant where read-write was offered but read-only chosen is read-only', async () => {
    ynabUserId = 'ynab-user-chose-ro';
    const tokens = await connect('read-only', 'read-only read-write');
    const sessionId = await initialize(tokens.access);
    expect(await listTools(tokens.access, sessionId)).toEqual(READ_TOOLS);
  });

  it('rejects a token bound to another resource at /mcp with a 401 challenge', async () => {
    // The authorization server refuses to start such a grant at all...
    const clientId = await register();
    const refused = await request(app)
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 'client-state',
        resource: 'https://other.example.com/mcp',
      });
    expect(refused.status).toBe(302);
    expect(new URL(refused.headers['location'] as string).searchParams.get('error')).toBe('invalid_target');

    // ...so plant a token a misconfigured or older server could have issued,
    // next to a twin that differs only in its resource.
    const good = await connect('read-write');
    expect(created.storage).toBeDefined();
    const planted = (token: string, resource: string) =>
      created.storage!.saveAccessToken({
        token,
        clientId: good.clientId,
        userId: ynabUserId,
        scopes: ['read-only', 'read-write'],
        expiresAt: Date.now() + 3600_000,
        resource,
        grantedScope: 'read-write',
      });
    await planted('foreign-access-token', 'https://other.example.com/mcp');
    await planted('twin-access-token', RESOURCE);

    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    };
    const res = await mcp('post', 'foreign-access-token').send(init);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(JSON.stringify(res.body)).not.toContain('foreign-access-token');
    expect(handle.sessions.size).toBe(0);

    // The twin with this server's resource is accepted, so the resource is the
    // only difference between the 401 and the 200.
    expect((await mcp('post', 'twin-access-token').send(init)).status).toBe(200);
    // And so is the grant's real token.
    expect((await mcp('post', good.access).send(init)).status).toBe(200);
  });
});
