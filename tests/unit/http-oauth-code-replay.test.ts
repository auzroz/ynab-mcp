/**
 * Authorization-code replay over HTTP (RFC 9700 section 4.2.4, RFC 6749
 * section 4.1.2, issue #42), through the mounted authorization server
 * (oidc-provider behind the AS stages, ADR-0002) and the bearer middleware on
 * /mcp: a second use of a code revokes the tokens issued from it (the grant:
 * grant-guard, D6, before the library), and the token endpoint answers an
 * unknown, a replayed and a revoked code with byte-identical responses. Only
 * the YNAB network calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
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

import { createHttpApp } from '../../src/http.js';
import * as ynabOauth from '../../src/auth/ynab-oauth.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { CookieJar, REDIRECT_URI, RESOURCE, browserFlow, pkcePair } from './helpers/oidc-app.js';

const CALLBACK = REDIRECT_URI;
/** The one description of every refused grant: the library's, and grant-guard's (D6). */
const INVALID_GRANT = { error: 'invalid_grant', error_description: 'grant request is invalid' };

function makeApp(): Promise<Express> {
  return createHttpApp(
    makeHttpConfig({
      publicUrl: 'https://mcp.example.com',
      resourceUrl: 'https://mcp.example.com/mcp',
      readOnly: false,
      authMode: 'oauth',
      oauthClientId: 'cid',
      oauthClientSecret: 'sec',
      encryptionKey: randomBytes(32).toString('base64'),
    })
  );
}

interface Grant {
  clientId: string;
  verifier: string;
  code: string;
}

async function register(app: Express): Promise<string> {
  const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: [CALLBACK], client_name: 'replay', token_endpoint_auth_method: 'none' });
  expect(reg.status).toBe(201);
  return reg.body.client_id as string;
}

/** Run the browser legs to an MCP authorization code, for a new client unless one is given. */
async function authorize(app: Express, existingClientId?: string): Promise<Grant> {
  const clientId = existingClientId ?? (await register(app));
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(app, new CookieJar(), { clientId, challenge, choice: 'read-only' });
  const code = flow.params.get('code');
  if (!code) throw new Error('no code');
  return { clientId, verifier, code };
}

function exchange(app: Express, grant: Grant, code = grant.code): request.Test {
  return request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: grant.clientId,
    code,
    code_verifier: grant.verifier,
    redirect_uri: CALLBACK,
    resource: RESOURCE,
  });
}

function refresh(app: Express, clientId: string, refreshToken: string): request.Test {
  return request(app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE });
}

/** An MCP initialize with `access`: 401 once the token is revoked. */
function initialize(app: Express, access: string): request.Test {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${access}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
}

/** Status, headers and body bytes, minus the headers that legitimately vary per request. */
function wire(res: request.Response): { status: number; headers: Record<string, unknown>; body: string } {
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (name === 'date' || name.startsWith('ratelimit') || name.startsWith('x-ratelimit')) continue;
    headers[name] = value;
  }
  return { status: res.status, headers, body: res.text };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(ynabOauth.exchangeCode).mockResolvedValue({
    accessToken: 'ya',
    refreshToken: 'yr',
    expiresAt: Date.now() + 7200_000,
  });
  vi.mocked(ynabOauth.getYnabUserId).mockResolvedValue('ynab-user-1');
  vi.mocked(ynabOauth.refreshAccessToken).mockResolvedValue({
    accessToken: 'ya2',
    refreshToken: 'yr2',
    expiresAt: Date.now() + 7200_000,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authorization-code replay at /token (RFC 9700)', () => {
  it('a replayed code revokes the access and refresh tokens it produced', async () => {
    const app = await makeApp();
    const grant = await authorize(app);
    const first = await exchange(app, grant);
    expect(first.status).toBe(200);
    const access = first.body.access_token as string;
    const refreshToken = first.body.refresh_token as string;
    expect((await initialize(app, access)).status).toBe(200);

    const replay = await exchange(app, grant);
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(INVALID_GRANT);

    expect((await initialize(app, access)).status).toBe(401);
    const refused = await refresh(app, grant.clientId, refreshToken);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_grant');
  });

  it('a replay also revokes tokens refreshed from the code, and leaves other connections alone', async () => {
    const app = await makeApp();
    const grant = await authorize(app);
    const first = await exchange(app, grant);
    const rotated = await refresh(app, grant.clientId, first.body.refresh_token as string);
    expect(rotated.status).toBe(200);
    // A second connection of the same user and client, and one from another client.
    const sameClientGrant = await authorize(app, grant.clientId);
    const sameClient = await exchange(app, sameClientGrant);
    const otherGrant = await authorize(app);
    const other = await exchange(app, otherGrant);

    expect((await exchange(app, grant)).status).toBe(400);

    expect((await initialize(app, rotated.body.access_token as string)).status).toBe(401);
    expect((await refresh(app, grant.clientId, rotated.body.refresh_token as string)).status).toBe(400);
    for (const [g, res] of [
      [sameClientGrant, sameClient],
      [otherGrant, other],
    ] as const) {
      expect((await initialize(app, res.body.access_token as string)).status).toBe(200);
      expect((await refresh(app, g.clientId, res.body.refresh_token as string)).status).toBe(200);
    }
  });

  it('answers an unknown, a replayed and a re-replayed code with byte-identical responses', async () => {
    const app = await makeApp();
    const grant = await authorize(app);
    expect((await exchange(app, grant)).status).toBe(200);

    const unknown = wire(await exchange(app, grant, randomBytes(32).toString('base64url')));
    const replayed = wire(await exchange(app, grant));
    const again = wire(await exchange(app, grant));

    expect(unknown.status).toBe(400);
    expect(replayed).toEqual(unknown);
    expect(again).toEqual(unknown);
    expect(JSON.parse(unknown.body)).toEqual(INVALID_GRANT);
  });

  it('the replay is logged without the code', async () => {
    const app = await makeApp();
    const grant = await authorize(app);
    await exchange(app, grant);
    await exchange(app, grant);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String);
    // grant-guard (D6) answers the replay and revokes the grant.
    expect(logged).toContain('[OAuth] A consumed credential was presented at /token (authorization code); revoked its grant');
    expect(logged.join(' ')).not.toContain(grant.code);
  });
});
