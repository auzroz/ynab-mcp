/**
 * Client authentication against hashed DCR client secrets (#52, gate G21,
 * ADR-0002 D5).
 *
 * /token and /revoke run host-validation, ip-limiter, bounded-parser,
 * cors-origin, method-check, route-limiter, client-auth (and on /token
 * grant-guard), then as-library. Client secrets are stored as `s256.` hashes;
 * the client-auth stage verifies the presented secret in constant time and
 * hands the library the stored hash. Without that stage, every confidential
 * client gets invalid_client from the library itself (fail closed, spike 40).
 * Wrong-secret attempts count against the route limiter and get 429 past it,
 * before client-auth runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Storage } from '../../src/storage/types.js';

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

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { CLIENT_AUTH_ROUTE_RATE_LIMIT } from '../../src/auth/as-router.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { TokenHasher } from '../../src/auth/token-hash.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { buildOidcTestApp, exchangeCode, registerClient, REDIRECT_URI } from './helpers/oidc-app.js';
import {
  authCodeKey,
  plantAuthCode,
  plantClient,
  plantUser,
  registerTestClient,
  storedClient,
  updateClient,
} from './helpers/oauth-state.js';

const HOST = 'mcp.example.com';
const PUBLIC_URL = `https://${HOST}`;
const RESOURCE = `${PUBLIC_URL}/mcp`;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

/** A DCR client as the registration response returns it. */
interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  [field: string]: unknown;
}

let handle: HttpApp;
let trace: string[];

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  trace = [];
  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      authMode: 'oauth',
      oauthClientId: 'cid',
      oauthClientSecret: 'sec',
      encryptionKey: randomBytes(32).toString('base64'),
      tokenPepper: TEST_TOKEN_PEPPER,
    }),
    { observeStage: (stage) => trace.push(stage) }
  );
});

afterEach(async () => {
  await handle.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  vi.restoreAllMocks();
});

const storage = (): Storage => created.storage as Storage;

/** DCR through /register; the secret comes back once, here. */
async function register(method?: 'none' | 'client_secret_post'): Promise<RegisteredClient> {
  const res = await registerTestClient(handle.app, {
    redirect_uris: ['https://client/cb'],
    client_name: 'test',
    ...(method ? { token_endpoint_auth_method: method } : {}),
  });
  expect(res.status).toBe(201);
  return res.body as RegisteredClient;
}

/** The stored `s256.` hash of a registered client's secret. */
async function storedHash(clientId: string): Promise<string> {
  const stored = await storedClient(storage(), clientId);
  return stored?.['client_secret_hash'] as string;
}

/** An MCP authorization code for `clientId`, stored as the AS stores one. */
async function plantCode(clientId: string, on: Storage = storage(), redirectUri = 'https://client/cb'): Promise<string> {
  // A code is only redeemable while its user is connected (STOR-1).
  await plantUser(on, { userId: 'ynab-user-1', grantedScope: 'read-only', encryptedRefreshToken: 'x' });
  return plantAuthCode(on, {
    clientId,
    userId: 'ynab-user-1',
    redirectUri,
    codeChallenge: CHALLENGE,
    scopes: [],
    expiresAt: Date.now() + 60_000,
    grantedScope: 'read-only',
  });
}

/** Whether the planted code is still unspent (live and not consumed). */
async function codeUnspent(code: string, on: Storage = storage()): Promise<boolean> {
  const row = await on.findOAuthRow(authCodeKey(code));
  return row !== undefined && row.consumedAt === undefined;
}

function token(fields: Record<string, string>): request.Test {
  return request(handle.app).post('/token').type('form').send(fields);
}

function codeGrant(clientId: string, code: string, secret?: string): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code,
    code_verifier: VERIFIER,
    client_id: clientId,
    ...(secret !== undefined ? { client_secret: secret } : {}),
  };
}

describe('one hasher', () => {
  it('builds the token hasher once per app, for storage and the provider alike', async () => {
    const fromSecrets = vi.spyOn(TokenHasher, 'fromSecrets');
    try {
      const other = await buildHttpApp(
        makeHttpConfig({
          publicUrl: PUBLIC_URL,
          resourceUrl: RESOURCE,
          authMode: 'oauth',
          oauthClientId: 'cid',
          oauthClientSecret: 'sec',
          encryptionKey: randomBytes(32).toString('base64'),
          tokenPepper: TEST_TOKEN_PEPPER,
        })
      );
      expect(fromSecrets).toHaveBeenCalledTimes(1);
      await other.mcp.close();
    } finally {
      fromSecrets.mockRestore();
    }
  });
});

describe('hashed client secrets at registration', () => {
  it('returns the secret once and stores only its s256. hash', async () => {
    const client = await register();
    expect(client.client_secret).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const stored = (await storedClient(storage(), client.client_id)) as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain(client.client_secret);
    expect(stored['client_secret']).toBeUndefined();
    expect(stored['client_secret_hash']).toMatch(/^s256\.[0-9a-f]{64}$/);
  });
});

describe('/token client authentication', () => {
  it('a confidential client with its secret gets tokens', async () => {
    const client = await register();
    const res = await token(codeGrant(client.client_id, await plantCode(client.client_id), client.client_secret));
    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(trace.slice(-3)).toEqual(['client-auth', 'grant-guard', 'as-library']);
  });

  it.each([
    ['a wrong secret', (_c: RegisteredClient, _h: string) => randomBytes(32).toString('hex'), 'Invalid client_secret'],
    ['the stored hash itself', (_c: RegisteredClient, h: string) => h, 'Invalid client_secret'],
    ['any s256. value', () => `s256.${'0'.repeat(64)}`, 'Invalid client_secret'],
    ['the secret with the s256. prefix', (c: RegisteredClient) => `s256.${c.client_secret}`, 'Invalid client_secret'],
    ['an empty secret', () => '', 'Client secret is required'],
  ])('refuses %s with invalid_client before the library runs', async (_name, secretOf, description) => {
    const client = await register();
    const hash = await storedHash(client.client_id);
    const code = await plantCode(client.client_id);
    trace.length = 0;
    const res = await token(codeGrant(client.client_id, code, secretOf(client, hash)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_client', error_description: description });
    // cors-origin ran first, so a browser client can still read it.
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(trace).not.toContain('as-library');
    expect(JSON.stringify(res.body)).not.toContain(hash);
    // The code was not spent: the right secret still redeems it.
    expect((await token(codeGrant(client.client_id, code, client.client_secret))).status).toBe(200);
  });

  it('refuses a missing secret, an unknown client and an expired secret', async () => {
    const client = await register();
    const code = await plantCode(client.client_id);
    expect((await token(codeGrant(client.client_id, code))).body).toEqual({
      error: 'invalid_client',
      error_description: 'Client secret is required',
    });
    expect((await token(codeGrant('no-such-client', code, client.client_secret))).body).toEqual({
      error: 'invalid_client',
      error_description: 'Invalid client_id',
    });
    await updateClient(storage(), client.client_id, { client_secret_expires_at: Math.floor(Date.now() / 1000) - 1 });
    expect((await token(codeGrant(client.client_id, code, client.client_secret))).body).toEqual({
      error: 'invalid_client',
      error_description: 'Client secret has expired',
    });
  });

  it('a public client passes through unchanged', async () => {
    const client = await register('none');
    expect(client.client_secret).toBeUndefined();
    const res = await token(codeGrant(client.client_id, await plantCode(client.client_id)));
    expect(res.status).toBe(200);
  });

  it('a client stored with a plaintext secret (as 0.4.x could have) still authenticates with it (hashed at rest)', async () => {
    const secret = randomBytes(32).toString('hex');
    await plantClient(storage(), {
      client_id: 'late-0.4.x-client',
      redirect_uris: ['https://client/cb'],
      client_secret: secret,
      client_secret_expires_at: 0,
    });
    expect(JSON.stringify(await storedClient(storage(), 'late-0.4.x-client'))).not.toContain(secret);
    expect((await token(codeGrant('late-0.4.x-client', await plantCode('late-0.4.x-client'), secret))).status).toBe(200);
    expect((await token(codeGrant('late-0.4.x-client', await plantCode('late-0.4.x-client'), 'nope'))).status).toBe(400);
  });

  it('answers a storage failure with a generic server_error', async () => {
    const client = await register();
    vi.spyOn(storage(), 'findOAuthRow').mockRejectedValueOnce(new Error('connect ECONNREFUSED postgres://u:hunter2@db'));
    const res = await token(codeGrant(client.client_id, 'x', client.client_secret));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'server_error', error_description: 'Internal Server Error' });
    expect(res.text).not.toContain('hunter2');
  });

  it('refuses the stored hash sent as an Authorization: Basic credential, and issues nothing', async () => {
    // The library accepts client_secret_basic for a client_secret_post client
    // (lib/shared/client_auth.js: either mechanism allows both methods) and
    // compares the presented value with the stored hash, so a Basic header
    // must never reach it unverified: a leaked hash would otherwise be a
    // credential (D5, fail closed). client-auth removes the header, as the SDK
    // ignored it: the library then sees no client credentials at all.
    const client = await register();
    const hash = await storedHash(client.client_id);
    const code = await plantCode(client.client_id);
    const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(hash)}`).toString('base64');
    const res = await request(handle.app)
      .post('/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: VERIFIER });
    expect(res.body.access_token).toBeUndefined();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(JSON.stringify(res.body)).not.toContain(hash);
    expect(await codeUnspent(code)).toBe(true);

    // With the client_id in the body as well, the hash in the header still doesn't count.
    const both = await request(handle.app)
      .post('/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: client.client_id });
    expect(both.body.access_token).toBeUndefined();
    expect(both.body).toEqual({ error: 'invalid_client', error_description: 'Client secret is required' });
    expect(await codeUnspent(code)).toBe(true);
  });

  it('refuses the stored hash sent as an Authorization: Basic credential at /revoke too', async () => {
    const client = await register();
    const hash = await storedHash(client.client_id);
    const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(hash)}`).toString('base64');
    const res = await request(handle.app)
      .post('/revoke')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ token: 'x'.repeat(43) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it(`counts wrong secrets against the route limiter: 429 past ${CLIENT_AUTH_ROUTE_RATE_LIMIT}, before client-auth`, async () => {
    const client = await register();
    for (let i = 0; i < CLIENT_AUTH_ROUTE_RATE_LIMIT; i++) {
      expect((await token(codeGrant(client.client_id, 'x', 'wrong'))).status).toBe(400);
    }
    trace.length = 0;
    const res = await token(codeGrant(client.client_id, 'x', client.client_secret));
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_requests');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // Host validation is off in this config, so the ip-limiter is the first stage.
    expect(trace).toEqual(['ip-limiter', 'bounded-parser', 'cors-origin', 'method-check', 'route-limiter']);
    // /revoke has its own budget.
    const revoke = await request(handle.app)
      .post('/revoke')
      .type('form')
      .send({ token: 'x', client_id: client.client_id, client_secret: client.client_secret });
    expect(revoke.status).toBe(200);
  });
});

describe('route limiter and CORS preflight', () => {
  it('does not count preflights, which cors-origin answers with CORS headers', async () => {
    const client = await register();
    for (let i = 0; i < CLIENT_AUTH_ROUTE_RATE_LIMIT + 5; i++) {
      const preflight = await request(handle.app)
        .options('/token')
        .set('Origin', 'https://client.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('*');
    }
    expect((await token(codeGrant(client.client_id, 'x', 'wrong'))).status).toBe(400);
  });
});

describe('/revoke client authentication', () => {
  it('accepts the secret and refuses the stored hash', async () => {
    const client = await register();
    const hash = await storedHash(client.client_id);
    const revoke = (secret: string) =>
      request(handle.app).post('/revoke').type('form').send({ token: 'x', client_id: client.client_id, client_secret: secret });
    expect((await revoke(client.client_secret as string)).status).toBe(200);
    const refused = await revoke(hash);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_client');
    expect(refused.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('fail closed (spike 40)', () => {
  it('without the client-auth stage, a confidential client with its real secret gets invalid_client from the library', async () => {
    // The library on its own app: no client-auth stage in front of /token.
    const bareStorage = new MemoryStorage();
    const { app } = buildOidcTestApp(bareStorage);
    const client = await registerClient(app, { token_endpoint_auth_method: 'client_secret_post' });
    expect(client.clientSecret).toBeDefined();
    const code = await plantCode(client.clientId, bareStorage, REDIRECT_URI);
    const res = await exchangeCode(app, {
      clientId: client.clientId,
      code,
      verifier: VERIFIER,
      clientSecret: client.clientSecret as string,
    });
    // The library's own refusal (D5: 401, where our stage answers 400).
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.body.access_token).toBeUndefined();
    // The code was never spent.
    expect(await codeUnspent(code, bareStorage)).toBe(true);
  });
});
