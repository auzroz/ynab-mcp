/**
 * RFC 8707 resource binding end to end over HTTP, through the mounted
 * authorization server (oidc-provider behind the AS stages, ADR-0002) and the
 * bearer middleware on /mcp. Only the YNAB network calls are mocked.
 */

import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>(
      '../../src/auth/ynab-oauth.js'
    );
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({
      accessToken: 'ya',
      refreshToken: 'yr',
      expiresAt: Date.now() + 7200_000,
    })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
    refreshAccessToken: vi.fn(async () => ({
      accessToken: 'ya2',
      refreshToken: 'yr2',
      expiresAt: Date.now() + 7200_000,
    })),
  };
});

// Keeps a handle on the storage the app creates, so a test can plant a token.
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
import { Encryptor } from '../../src/crypto.js';
import type { Storage } from '../../src/storage/types.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER, legacyToken } from './helpers/token-hasher.js';
import { plantAccessToken, plantUser } from './helpers/oauth-state.js';
import { CookieJar, browse, browserFlow, interactionUid } from './helpers/oidc-app.js';
import type { HttpConfig } from '../../src/config/environment.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const CALLBACK = 'https://client.example/cb';
const ENCRYPTION_KEY = randomBytes(32).toString('base64');

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return makeHttpConfig({
    publicUrl: 'https://mcp.example.com',
    resourceUrl: RESOURCE,
    readOnly: false,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: ENCRYPTION_KEY,
    // The shared test pepper, so a test can plant tokens the app reads.
    tokenPepper: TEST_TOKEN_PEPPER,
    // A verified client (#55b), so /authorize errors are redirected back to it.
    verifiedRedirectUris: [CALLBACK],
    ...overrides,
  });
}

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

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function register(app: Express): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [CALLBACK], client_name: 'e2e', token_endpoint_auth_method: 'none' });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

function authorizeQuery(clientId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    ...extra,
  };
}

/**
 * Drive /authorize -> consent -> YNAB -> complete -> the library's resume;
 * returns the MCP authorization code. Asking for read-write at start is capped
 * by the server when the client requested only read-only.
 */
async function authorizeToCode(
  app: Express,
  clientId: string,
  extra: Record<string, string> = {}
): Promise<string> {
  const { scope, resource, ...rest } = extra;
  const flow = await browserFlow(app, new CookieJar(), {
    clientId,
    challenge,
    scope,
    resource,
    extra: rest,
    choice: 'read-write',
  });
  const code = flow.params.get('code');
  if (!code) throw new Error('no code');
  return code;
}

async function token(app: Express, form: Record<string, string>): Promise<request.Response> {
  return request(app).post('/token').type('form').send(form);
}

async function issueTokens(
  app: Express,
  extra: { authorize?: Record<string, string>; token?: Record<string, string> } = {}
): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId = await register(app);
  const code = await authorizeToCode(app, clientId, extra.authorize);
  const res = await token(app, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
    ...extra.token,
  });
  expect(res.status).toBe(200);
  return { clientId, access: res.body.access_token, refresh: res.body.refresh_token };
}

/** A non-initialize POST with no session: served (200) means the bearer check passed (stateless /mcp). */
async function probeMcp(app: Express, accessToken: string): Promise<request.Response> {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/authorize resource indicator', () => {
  it('redirects a foreign resource back with error=invalid_target', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const res = await request(app)
      .get('/authorize')
      .query(authorizeQuery(clientId, { resource: 'https://evil.example.com/mcp' }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('error')).toBe('invalid_target');
    expect(loc.searchParams.get('state')).toBe('client-state');
    expect(loc.searchParams.get('iss')).toBe('https://mcp.example.com/');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('shows the consent page for the configured resource (normalized spelling)', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const jar = new CookieJar();
    const query = new URLSearchParams(authorizeQuery(clientId, { resource: 'HTTPS://MCP.EXAMPLE.COM:443/mcp' }));
    const auth = await browse(app, jar, `/authorize?${query.toString()}`);
    expect(auth.status).toBe(303);
    interactionUid(auth.headers['location'] as string);
    const res = await browse(app, jar, auth.headers['location'] as string);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connect your YNAB budget');
  });
});

describe('/token resource and scope checks', () => {
  it('issues tokens for a matching resource and they work at /mcp', async () => {
    const app = await createHttpApp(makeConfig());
    const { access } = await issueTokens(app, {
      authorize: { resource: RESOURCE },
      token: { resource: RESOURCE },
    });
    expect((await probeMcp(app, access)).status).toBe(200);

    const init = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${access}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(init.status).toBe(200);
    expect(init.headers['mcp-session-id']).toBeUndefined();
  });

  it('rejects a token request whose resource differs from the authorized one', async () => {
    const app = await createHttpApp(makeConfig());
    const clientId = await register(app);
    const code = await authorizeToCode(app, clientId, { resource: RESOURCE });
    const res = await token(app, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      resource: 'https://evil.example.com/mcp',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
    expect(res.body.access_token).toBeUndefined();
  });

  it('rejects a refresh with a different resource (invalid_target)', async () => {
    const app = await createHttpApp(makeConfig());
    const { clientId, refresh } = await issueTokens(app, { authorize: { resource: RESOURCE } });
    const res = await token(app, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refresh,
      resource: 'https://mcp.example.com/other',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');

    // The refresh token survives a resource mistake.
    const ok = await token(app, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refresh,
      resource: RESOURCE,
    });
    expect(ok.status).toBe(200);
  });

  it('rejects a refresh that widens scope (invalid_scope)', async () => {
    const app = await createHttpApp(makeConfig());
    const { clientId, refresh } = await issueTokens(app, { authorize: { scope: 'read-only' } });
    const res = await token(app, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refresh,
      scope: 'read-only read-write',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(res.body.access_token).toBeUndefined();
  });

  it('allows a refresh that narrows scope', async () => {
    const app = await createHttpApp(makeConfig());
    const { clientId, refresh } = await issueTokens(app, {
      authorize: { scope: 'read-only read-write' },
    });
    const res = await token(app, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refresh,
      scope: 'read-only',
    });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('read-only');
  });
});

describe('/mcp bearer audience check', () => {
  /** An app whose storage holds a connected user, and a token planted for `audience`. */
  async function appWithToken(audience: string): Promise<{ app: Express; storage: Storage; access: string }> {
    const app = await createHttpApp(makeConfig());
    const storage = created.storage as Storage;
    await plantUser(storage, {
      userId: 'ynab-user-1',
      grantedScope: 'read-only',
      encryptedRefreshToken: new Encryptor(ENCRYPTION_KEY).encrypt('yr'),
    });
    const access = await plantAccessToken(storage, {
      clientId: 'c',
      userId: 'ynab-user-1',
      scopes: ['read-only'],
      expiresAt: Date.now() + 3_600_000,
      resource: audience,
      grantedScope: 'read-only',
    });
    return { app, storage, access };
  }

  it('accepts a stored token whose audience is the resource (the control)', async () => {
    const { app, access } = await appWithToken(RESOURCE);
    expect((await probeMcp(app, access)).status).toBe(200);
  });

  it('rejects (401) a stored token whose audience is another resource', async () => {
    const { app, access } = await appWithToken('https://other.example.com/mcp');
    const res = await probeMcp(app, access);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('rejects (401) a stored token with no audience at all', async () => {
    const { app, storage, access } = await appWithToken(RESOURCE);
    // The same row read back without its `aud`.
    const find = storage.findOAuthRow.bind(storage);
    vi.spyOn(storage, 'findOAuthRow').mockImplementation(async (key) => {
      const row = await find(key);
      if (row?.model !== 'AccessToken') return row;
      const { aud: _aud, ...payload } = JSON.parse(row.payload) as Record<string, unknown>;
      return { ...row, payload: JSON.stringify(payload) };
    });
    expect((await probeMcp(app, access)).status).toBe(401);
  });
});

// Durable storage lets two server configurations share tokens, as after an
// operator changes MCP_RESOURCE_URL, and lets the test plant 0.3.x rows.
const sqliteAvailable = ((): boolean => {
  try {
    createRequire(import.meta.url)('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const requireDbTests = process.env.REQUIRE_DB_TESTS === '1';

describe.skipIf(!sqliteAvailable && !requireDbTests)('/mcp with shared SQLite storage', () => {
  const files: string[] = [];
  afterAll(() => {
    for (const f of files) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${f}${suffix}`, { force: true });
    }
  });

  function sqliteConfig(file: string, overrides: Partial<HttpConfig> = {}): HttpConfig {
    return makeConfig({ storageDriver: 'sqlite', sqlitePath: file, ...overrides });
  }

  it('a token bound to another resource gets 401 at /mcp', async () => {
    const file = join(tmpdir(), `ynab-mcp-resource-${randomUUID()}.db`);
    files.push(file);
    const appA = await createHttpApp(sqliteConfig(file));
    const appB = await createHttpApp(
      sqliteConfig(file, { resourceUrl: 'https://mcp.example.com/other/mcp' })
    );
    const { access } = await issueTokens(appA, { authorize: { resource: RESOURCE } });

    expect((await probeMcp(appA, access)).status).toBe(200);
    const res = await probeMcp(appB, access);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(JSON.stringify(res.body)).not.toContain(access);
  });

  // Until 0.5.0 a 0.3.x token (no stored resource) was accepted as bound to the
  // configured resource. The cut-over reads only oauth_rows (ADR-0002 D12), so
  // every token of an older release, of any shape, is refused.
  it('a 0.3.x access token (no stored resource) is refused after the cut-over (D12)', async () => {
    const file = join(tmpdir(), `ynab-mcp-resource-${randomUUID()}.db`);
    files.push(file);
    // Create the YNAB user through the normal flow, then plant a 0.3.x row for
    // it: a 43-character plaintext key with no resource. The next start's M3
    // rehash (#52) turns its key into its h1. form; nothing reads it.
    await issueTokens(await createHttpApp(sqliteConfig(file)));
    const legacy = legacyToken();
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
    const raw = new Database(file);
    try {
      raw
        .prepare('INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(legacy, 'legacy-client', 'ynab-user-1', '[]', Date.now() + 3_600_000);
    } finally {
      raw.close();
    }
    const app = await createHttpApp(sqliteConfig(file));

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${legacy}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeBody);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });
});
