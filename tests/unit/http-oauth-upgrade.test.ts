/**
 * The 0.4.x upgrade path through the cut-over (ADR-0002 D12), on the real app
 * over SQLite and Postgres: a database as a 0.4.x instance left it (after
 * #52's M3, before M4) is opened by this build, which runs M4.
 *
 *   - registered clients are converted and still work: a confidential client
 *     authenticates with its original secret, and a public client signs in;
 *   - a 0.4.x access token, refresh token and code are each refused: nothing
 *     reads the old token tables, which keep their rows for a rollback.
 *
 * YNAB is mocked. Memory storage keeps nothing across processes, so it has no
 * upgrade.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

const factory = vi.hoisted(() => ({ open: undefined as (() => Promise<Storage>) | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) =>
      factory.open ? factory.open() : actual.createStorage(...args),
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { exchangeCode as ynabExchangeCode, getYnabUserId, refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { hashClientSecret } from '../../src/auth/token-hash.js';
import { Encryptor } from '../../src/crypto.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER, legacyToken, testKey } from './helpers/token-hasher.js';
import { testDrivers, cleanupDrivers, type DriverHandle } from './helpers/storage-drivers.js';
import { bearer, mcpInitialize } from './helpers/mcp-call.js';
import { PUBLIC_URL, REDIRECT_URI, CookieJar, browserFlow, exchangeCode, pkcePair, refresh } from './helpers/oidc-app.js';

const RESOURCE = `${PUBLIC_URL}/mcp`;
const USER = 'ynab-user-1';
const SECRET = 'a-0.4.x-client-secret';
const DAY = 86_400_000;

/** 0.4.x clients as M3 left them (the secret hashed). */
const CONFIDENTIAL = {
  client_id_issued_at: 1_760_000_000,
  client_secret_expires_at: 0,
  client_secret_hash: hashClientSecret(SECRET),
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: 'client_secret_post',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'Claude-like',
  scope: 'read-only read-write',
};
const PUBLIC = {
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'Inspector-like',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.mocked(ynabExchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access',
    refreshToken: 'ynab-refresh',
    expiresAt: Date.now() + 7_200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue(USER);
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-2',
    refreshToken: 'ynab-refresh-2',
    expiresAt: Date.now() + 7_200_000,
  }));
});

afterEach(async () => {
  factory.open = undefined;
  vi.restoreAllMocks();
  await cleanupDrivers();
});

/** What a 0.4.x instance holds: two clients, a user, and one live access token, refresh token and code. */
async function plant04x(h: DriverHandle, encryptionKey: string) {
  const sql = h.sql!;
  const at = Date.now() - 10 * DAY;
  for (const [id, client] of [
    ['c-confidential', CONFIDENTIAL],
    ['c-public', PUBLIC],
  ] as const) {
    await sql('INSERT INTO oauth_clients (client_id, client_json, created_at, last_authorized_at) VALUES ($1, $2, $3, $4)', [
      id,
      JSON.stringify(client),
      at,
      at,
    ]);
  }
  await h.storage.upsertUser({
    userId: USER,
    grantedScope: 'read-write',
    encryptedRefreshToken: new Encryptor(encryptionKey).encrypt('ynab-refresh-0'),
    updatedAt: at,
  });
  const values = { access: legacyToken(), refresh: legacyToken(), code: legacyToken() };
  const verifier = 'v'.repeat(64);
  const grant = { clientId: 'c-confidential', userId: USER, scopes: ['read-write'], resource: RESOURCE, grantedScope: 'read-write' as const };
  await h.storage.saveAccessToken({ token: testKey('access', values.access), ...grant, expiresAt: Date.now() + 3_600_000, familyId: 'f1' });
  await h.storage.saveRefreshToken({ token: testKey('refresh', values.refresh), ...grant, familyId: 'f1' });
  await h.storage.saveAuthCode({
    code: testKey('code', values.code),
    ...grant,
    redirectUri: REDIRECT_URI,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    expiresAt: Date.now() + 600_000,
  });
  return { ...values, verifier };
}

/** The database as the last build before M4 left it: no oauth_rows, no converted_at, schema version 4. */
async function makePreM4(h: DriverHandle): Promise<void> {
  const sql = h.sql!;
  await sql('DROP TABLE oauth_rows');
  await sql('ALTER TABLE oauth_clients DROP COLUMN converted_at');
  await sql("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'");
}

async function count(h: DriverHandle, table: string): Promise<number> {
  return Number((await h.sql!(`SELECT count(*) AS n FROM ${table}`))[0]?.['n']);
}

for (const driver of testDrivers.filter((d) => d.kind !== 'memory')) {
  describe.skipIf(!driver.enabled)(`D12: a 0.4.x database through the cut-over (${driver.name})`, () => {
    let handle: HttpApp | undefined;
    afterEach(async () => {
      await handle?.mcp.close();
      handle = undefined;
    });

    async function upgrade() {
      const h = await driver.open();
      const encryptionKey = randomBytes(32).toString('base64');
      const old = await plant04x(h, encryptionKey);
      await makePreM4(h);
      // This build opens the database (M4 runs here) and serves it.
      factory.open = () => h.reopen();
      handle = await buildHttpApp(
        makeHttpConfig({
          publicUrl: PUBLIC_URL,
          resourceUrl: RESOURCE,
          readOnly: false,
          authMode: 'oauth',
          oauthClientId: 'ynab-client-id',
          oauthClientSecret: 'ynab-client-secret',
          encryptionKey,
          tokenPepper: TEST_TOKEN_PEPPER,
          storageDriver: driver.kind as 'sqlite' | 'postgres',
          sqlitePath: 'opened-by-the-test',
          databaseUrl: h.connectionString ?? 'opened-by-the-test',
        })
      );
      return { h, app: handle.app, old };
    }

    it('converts the registered clients: the confidential one authenticates with its original secret', async () => {
      const { app } = await upgrade();
      const { verifier, challenge } = pkcePair();
      const flow = await browserFlow(app, new CookieJar(), { clientId: 'c-confidential', challenge, resource: RESOURCE });
      const tokens = await exchangeCode(app, {
        clientId: 'c-confidential',
        clientSecret: SECRET,
        code: flow.params.get('code') as string,
        verifier,
      });
      expect(tokens.status).toBe(200);
      expect((await mcpInitialize(app, bearer(tokens.body.access_token as string))).status).toBe(200);
      // A wrong secret is still refused.
      const again = await browserFlow(app, new CookieJar(), { clientId: 'c-confidential', challenge, resource: RESOURCE });
      const wrong = await exchangeCode(app, {
        clientId: 'c-confidential',
        clientSecret: 'not-the-secret',
        code: again.params.get('code') as string,
        verifier,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('invalid_client');
    });

    it('converts the registered clients: the public one signs in', async () => {
      const { app } = await upgrade();
      const { verifier, challenge } = pkcePair();
      const flow = await browserFlow(app, new CookieJar(), { clientId: 'c-public', challenge, resource: RESOURCE });
      const tokens = await exchangeCode(app, { clientId: 'c-public', code: flow.params.get('code') as string, verifier });
      expect(tokens.status).toBe(200);
    });

    it('refuses a 0.4.x access token, refresh token and code, and leaves the old rows for a rollback', async () => {
      const { h, app, old } = await upgrade();
      const mcp = await mcpInitialize(app, bearer(old.access));
      expect(mcp.status).toBe(401);
      expect(mcp.body.error).toBe('invalid_token');

      const refreshed = await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: old.refresh, client_id: 'c-confidential', client_secret: SECRET });
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe('invalid_grant');

      const redeemed = await exchangeCode(app, { clientId: 'c-confidential', clientSecret: SECRET, code: old.code, verifier: old.verifier });
      expect(redeemed.status).toBe(400);
      expect(redeemed.body.error).toBe('invalid_grant');

      // Ignored, not migrated or deleted: the sweep and account deletion clear them (D12).
      expect(await count(h, 'access_tokens')).toBe(1);
      expect(await count(h, 'refresh_tokens')).toBe(1);
      expect(await count(h, 'auth_codes')).toBe(1);
      expect(await count(h, 'oauth_clients')).toBe(2);
    });

    it('a public client refreshing with a 0.4.x refresh token is refused too', async () => {
      const { app, old } = await upgrade();
      const res = await refresh(app, { clientId: 'c-public', refreshToken: old.refresh });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });
  });
}
