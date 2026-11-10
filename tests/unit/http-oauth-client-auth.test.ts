/**
 * Client authentication against hashed DCR client secrets (#52, gate G21).
 *
 * /token and /revoke run host-validation, bounded-parser, route-limiter,
 * client-auth, sdk-router. Client secrets are stored as `s256.` hashes; the
 * client-auth stage verifies the presented secret in constant time and hands
 * the SDK the stored hash. Without that stage, every confidential client gets
 * invalid_client (fail closed). Wrong-secret attempts count against the route
 * limiter and get 429 past it, before client-auth runs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
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
import { McpOAuthProvider } from '../../src/auth/mcp-provider.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { Encryptor } from '../../src/crypto.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';

const HOST = 'mcp.example.com';
const PUBLIC_URL = `https://${HOST}`;
const RESOURCE = `${PUBLIC_URL}/mcp`;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let handle: HttpApp;
let trace: string[];

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

const storage = (): Storage => created.storage as Storage;

/** DCR through /register; the secret comes back once, here. */
async function register(method?: 'none' | 'client_secret_post'): Promise<OAuthClientInformationFull> {
  const res = await request(handle.app)
    .post('/register')
    .send({
      redirect_uris: ['https://client/cb'],
      client_name: 'test',
      ...(method ? { token_endpoint_auth_method: method } : {}),
    });
  expect(res.status).toBe(201);
  return res.body as OAuthClientInformationFull;
}

/** An MCP authorization code for `clientId`, stored as the AS stores one. */
async function plantCode(clientId: string): Promise<string> {
  const { value, key } = TEST_TOKEN_HASHER.issue('code');
  await storage().saveAuthCode({
    code: key,
    clientId,
    userId: 'ynab-user-1',
    redirectUri: 'https://client/cb',
    codeChallenge: CHALLENGE,
    scopes: [],
    expiresAt: Date.now() + 60_000,
    grantedScope: 'read-only',
  });
  return value;
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

describe('hashed client secrets at registration', () => {
  it('returns the secret once and stores only its s256. hash', async () => {
    const client = await register();
    expect(client.client_secret).toMatch(/^[0-9a-f]{64}$/);
    const stored = (await storage().getClient(client.client_id)) as unknown as Record<string, unknown>;
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
    expect(res.body.access_token).toMatch(/^ymcp1_/);
    expect(trace.slice(-3)).toEqual(['route-limiter', 'client-auth', 'sdk-router']);
  });

  it.each([
    ['a wrong secret', (_c: OAuthClientInformationFull, _h: string) => randomBytes(32).toString('hex'), 'Invalid client_secret'],
    ['the stored hash itself', (_c: OAuthClientInformationFull, h: string) => h, 'Invalid client_secret'],
    ['any s256. value', () => `s256.${'0'.repeat(64)}`, 'Invalid client_secret'],
    ['the secret with the s256. prefix', (c: OAuthClientInformationFull) => `s256.${c.client_secret}`, 'Invalid client_secret'],
    ['an empty secret', () => '', 'Client secret is required'],
  ])('refuses %s with invalid_client before the SDK runs', async (_name, secretOf, description) => {
    const client = await register();
    const hash = ((await storage().getClient(client.client_id)) as unknown as Record<string, string>)['client_secret_hash']!;
    const code = await plantCode(client.client_id);
    trace.length = 0;
    const res = await token(codeGrant(client.client_id, code, secretOf(client, hash)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_client', error_description: description });
    expect(trace).not.toContain('sdk-router');
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
    const stored = (await storage().getClient(client.client_id)) as OAuthClientInformationFull;
    await storage().saveClient({ ...stored, client_secret_expires_at: Math.floor(Date.now() / 1000) - 1 });
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

  it('a secret a 0.4.x process stored in plaintext after the migration still authenticates (hashed on read)', async () => {
    const secret = randomBytes(32).toString('hex');
    await storage().saveClient({
      client_id: 'late-0.4.x-client',
      redirect_uris: ['https://client/cb'],
      client_secret: secret,
      client_secret_expires_at: 0,
    } as OAuthClientInformationFull);
    expect((await token(codeGrant('late-0.4.x-client', await plantCode('late-0.4.x-client'), secret))).status).toBe(200);
    expect((await token(codeGrant('late-0.4.x-client', await plantCode('late-0.4.x-client'), 'nope'))).status).toBe(400);
  });

  it('answers a storage failure with a generic server_error', async () => {
    const client = await register();
    vi.spyOn(storage(), 'getClient').mockRejectedValueOnce(new Error('connect ECONNREFUSED postgres://u:hunter2@db'));
    const res = await token(codeGrant(client.client_id, 'x', client.client_secret));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'server_error', error_description: 'Internal Server Error' });
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
    // Host validation is off in this config, so the parser is the first stage.
    expect(trace).toEqual(['bounded-parser', 'route-limiter']);
    // /revoke has its own budget.
    const revoke = await request(handle.app)
      .post('/revoke')
      .type('form')
      .send({ token: 'x', client_id: client.client_id, client_secret: client.client_secret });
    expect(revoke.status).toBe(200);
  });
});

describe('route limiter and CORS preflight', () => {
  it('does not count preflights, which the SDK answers with CORS headers', async () => {
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
    const hash = ((await storage().getClient(client.client_id)) as unknown as Record<string, string>)['client_secret_hash']!;
    const revoke = (secret: string) =>
      request(handle.app).post('/revoke').type('form').send({ token: 'x', client_id: client.client_id, client_secret: secret });
    expect((await revoke(client.client_secret as string)).status).toBe(200);
    const refused = await revoke(hash);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_client');
  });
});

describe('fail closed', () => {
  it('without the client-auth stage, a confidential client with its real secret gets invalid_client', async () => {
    const storage = new MemoryStorage();
    const provider = new McpOAuthProvider({
      storage,
      encryptor: new Encryptor(randomBytes(32).toString('base64')),
      tokenHasher: TEST_TOKEN_HASHER,
      ynab: { clientId: 'cid', clientSecret: 'sec' },
      publicUrl: PUBLIC_URL,
      allowWrite: true,
      globalReadOnly: false,
      accessTokenTtlSec: 3600,
      authCodeTtlSec: 600,
    });
    const secret = randomBytes(32).toString('hex');
    const client = await provider.clientsStore.registerClient({
      redirect_uris: ['https://client/cb'],
      client_secret: secret,
      client_secret_expires_at: 0,
    } as OAuthClientInformationFull);
    const { value, key } = TEST_TOKEN_HASHER.issue('code');
    await storage.saveAuthCode({
      code: key,
      clientId: client.client_id,
      userId: 'u',
      redirectUri: 'https://client/cb',
      codeChallenge: CHALLENGE,
      scopes: [],
      expiresAt: Date.now() + 60_000,
    });
    // The SDK's token handler alone, as if the stage had been unmounted.
    const bare = express();
    bare.use('/token', tokenHandler({ provider, rateLimit: false }));
    const res = await request(bare).post('/token').type('form').send(codeGrant(client.client_id, value, secret));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    // The code was never spent.
    expect(await storage.takeAuthCode(key)).toBeDefined();
  });
});
