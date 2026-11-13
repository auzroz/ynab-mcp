/**
 * /mcp's bearer stage on v2's `requireBearerAuth` (@modelcontextprotocol/express,
 * WS7.3). Gate G6: every way a token can fail verification answers 401 with
 * the `resource_metadata` challenge, never 500: a verifier failure (a storage
 * error, a storage timeout), an expired token, a token for another resource
 * (RFC 8707) and a malformed one. Nothing upstream reaches the response.
 *
 * Storage is the app's own (memory, or Postgres for the real timeouts); the
 * factory is wrapped only to reach it. No YNAB call is made: every request
 * here stops at or just after the bearer stage.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

const factory = vi.hoisted(() => ({
  storage: undefined as Storage | undefined,
  /** Replaces the storage factory for one test (the Postgres timeouts). */
  override: undefined as (() => Promise<Storage>) | undefined,
}));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      factory.storage = factory.override ? await factory.override() : await actual.createStorage(...args);
      return factory.storage;
    },
  };
});

import { createHttpApp } from '../../src/http.js';
import { MemoryStorage } from '../../src/storage/memory.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER, legacyToken } from './helpers/token-hasher.js';
import { INVALID_ACCESS_TOKEN_MESSAGE } from './helpers/invalid-token.js';
import { cleanupDrivers, testDrivers } from './helpers/storage-drivers.js';
import type { HttpConfig } from '../../src/config/environment.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const RESOURCE_METADATA = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const USER = 'ynab-user-1';

function makeConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return makeHttpConfig({
    publicUrl: 'https://mcp.example.com',
    resourceUrl: RESOURCE,
    readOnly: false,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
    // The test hasher's pepper, so a token minted here is one the app accepts.
    tokenPepper: TEST_TOKEN_PEPPER,
    ...overrides,
  });
}

/** The app and the storage it opened, with the user every seeded token belongs to. */
async function startApp(overrides: Partial<HttpConfig> = {}): Promise<{ app: Express; storage: Storage }> {
  const app = await createHttpApp(makeConfig(overrides));
  const storage = factory.storage;
  if (!storage) throw new Error('the app opened no storage');
  await storage.upsertUser({ userId: USER, grantedScope: 'read-write', encryptedRefreshToken: 'x', updatedAt: Date.now() });
  return { app, storage };
}

/** Issue a token the way the AS does and store it; returns the bearer value. */
async function seedToken(
  storage: Storage,
  overrides: { expiresAt?: number; resource?: string; scopes?: string[] } = {}
): Promise<string> {
  const issued = TEST_TOKEN_HASHER.issue('access');
  await storage.saveAccessToken({
    token: issued.key,
    clientId: 'c1',
    userId: USER,
    scopes: overrides.scopes ?? ['read-only'],
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    resource: overrides.resource ?? RESOURCE,
    grantedScope: 'read-only',
  });
  return issued.value;
}

type Method = 'post' | 'get' | 'delete';

function mcp(app: Express, authorization: string | undefined, method: Method = 'post'): request.Test {
  let req = request(app)[method]('/mcp').set('Accept', 'application/json, text/event-stream');
  if (authorization !== undefined) req = req.set('Authorization', authorization);
  return method === 'post' ? req.send({ jsonrpc: '2.0', id: 1, method: 'ping' }) : req;
}

/** G6: 401, the invalid_token challenge with resource_metadata, an OAuth error body. */
function expectChallenge(res: request.Response, description = INVALID_ACCESS_TOKEN_MESSAGE): void {
  expect(res.status, JSON.stringify(res.body)).toBe(401);
  expect(res.body).toEqual({ error: 'invalid_token', error_description: description });
  expect(res.headers['www-authenticate']).toBe(
    `Bearer error="invalid_token", error_description="${description}", resource_metadata="${RESOURCE_METADATA}"`
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  factory.override = undefined;
  factory.storage = undefined;
  await cleanupDrivers();
});

describe('/mcp answers every token-verification failure with 401 and resource_metadata, never 500 (G6)', () => {
  const failures: Array<[string, unknown, RegExp]> = [
    [
      'a storage error',
      new Error('connect ECONNREFUSED 10.1.2.3:5432 (postgres://app:hunter2@db.internal/ynab)'),
      /ECONNREFUSED/,
    ],
    [
      'a Postgres statement timeout',
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      /statement timeout/,
    ],
    ['a pg client-side query timeout', new Error('Query read timeout'), /Query read timeout/],
    ['a pg pool connection timeout', new Error('timeout exceeded when trying to connect'), /timeout exceeded/],
    ['a SQLite busy timeout', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), /database is locked/],
    ['a thrown non-Error value', 'boom', /An error occurred|boom/],
  ];

  it.each(failures)('a verifier failure: %s', async (_name, failure, logged) => {
    const { app, storage } = await startApp();
    const token = await seedToken(storage);
    vi.spyOn(storage, 'getAccessToken').mockRejectedValue(failure);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (const method of ['post', 'get', 'delete'] as const) {
      const res = await mcp(app, `Bearer ${token}`, method);
      expectChallenge(res);
      const wire = `${res.text} ${String(res.headers['www-authenticate'])}`;
      expect(wire).not.toMatch(/server_error|ECONNREFUSED|hunter2|10\.1\.2\.3|timeout|locked|boom/);
    }

    // Logged for the operator, sanitized, without the token.
    expect(errors).toHaveBeenCalledTimes(3);
    for (const call of errors.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).toMatch(/^\[OAuth\] Access token verification failed; refused as invalid_token:/);
      expect(line).toMatch(logged);
      expect(line).not.toContain(token);
      expect(line).not.toContain('hunter2');
    }
  });

  it('an expired token: dropped by storage', async () => {
    const { app, storage } = await startApp();
    expectChallenge(await mcp(app, `Bearer ${await seedToken(storage, { expiresAt: Date.now() - 1_000 })}`));
  });

  it("an expired token: refused by the middleware's own expiry check", async () => {
    // A record storage still returns but that is past its expiry by the time
    // the middleware compares (a token in its last second, read at the edge).
    const { app } = await startApp();
    vi.spyOn(MemoryStorage.prototype, 'getAccessToken').mockResolvedValue({
      token: 'k',
      clientId: 'c1',
      userId: USER,
      scopes: ['read-only'],
      expiresAt: Date.now() - 5_000,
      resource: RESOURCE,
    });
    expectChallenge(await mcp(app, `Bearer ${TEST_TOKEN_HASHER.issue('access').value}`), 'Token has expired');
  });

  it('a token bound to another resource (RFC 8707)', async () => {
    const { app, storage } = await startApp();
    const res = await mcp(app, `Bearer ${await seedToken(storage, { resource: 'https://mcp.example.com/other' })}`);
    expectChallenge(res);
  });

  const malformed: Array<[string, string | undefined, string]> = [
    ['no Authorization header', undefined, 'Missing Authorization header'],
    ['another scheme', 'Basic YWJjOmRlZg==', "Invalid Authorization header format, expected 'Bearer TOKEN'"],
    ['a bearer with no token', 'Bearer', "Invalid Authorization header format, expected 'Bearer TOKEN'"],
    ['a bearer with an empty token', 'Bearer ', "Invalid Authorization header format, expected 'Bearer TOKEN'"],
    ['a value of no known shape', 'Bearer not-a-real-token', INVALID_ACCESS_TOKEN_MESSAGE],
    ['an issued shape with a forged tag', `Bearer ymcp1_${'A'.repeat(43)}_${'B'.repeat(22)}`, INVALID_ACCESS_TOKEN_MESSAGE],
    ['an unknown token of the 0.4.x shape', `Bearer ${legacyToken()}`, INVALID_ACCESS_TOKEN_MESSAGE],
    ['quotes and backslashes', 'Bearer a"b\\c', INVALID_ACCESS_TOKEN_MESSAGE],
    ['a very long value', `Bearer ${'x'.repeat(4096)}`, INVALID_ACCESS_TOKEN_MESSAGE],
  ];

  it.each(malformed)('a malformed token: %s', async (_name, authorization, description) => {
    const { app } = await startApp();
    const res = await mcp(app, authorization);
    expectChallenge(res, description);
    const presented = authorization?.split(' ')[1];
    if (presented) expect(`${res.text} ${String(res.headers['www-authenticate'])}`).not.toContain(presented);
  });

  it('reads storage on every request: no bearer-verification cache (ADR-0001 D7)', async () => {
    const { app, storage } = await startApp();
    const token = await seedToken(storage);
    const reads = vi.spyOn(storage, 'getAccessToken');
    expect((await mcp(app, `Bearer ${token}`)).status).not.toBe(401);
    await storage.deleteAccessToken(TEST_TOKEN_HASHER.keyFor('access', token) as string);
    expectChallenge(await mcp(app, `Bearer ${token}`));
    expect(reads).toHaveBeenCalledTimes(2);
  });
});

describe('insufficient scope is unchanged', () => {
  it('a read-only token passes the bearer stage: /mcp sets no requiredScopes, so no 403 insufficient_scope', async () => {
    // Read-only access is enforced past the bearer stage (write tools hidden
    // and refused; http-oauth-write-policy.test.ts), as before the move.
    const { app, storage } = await startApp();
    const res = await mcp(app, `Bearer ${await seedToken(storage, { scopes: ['read-only'] })}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('insufficient_scope');
  });
});

describe('the advertised resource_metadata URL keeps its derivation', () => {
  // v2's getOAuthProtectedResourceMetadataUrl keeps a query and drops a
  // trailing slash, where server-legacy's (still used by as-router.ts) does
  // the opposite. These pin today's URLs, so a switch (#47) is deliberate.
  it.each([
    ['https://mcp.example.com/mcp/', 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp/'],
    ['https://mcp.example.com/mcp?tenant=a', 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'],
  ])('MCP_RESOURCE_URL=%s advertises %s and serves the document there', async (resourceUrl, metadataUrl) => {
    const { app } = await startApp({ resourceUrl });
    const res = await mcp(app, undefined);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${metadataUrl}"`);
    const doc = await request(app).get(new URL(metadataUrl).pathname);
    expect(doc.status).toBe(200);
    expect(doc.body.resource).toBe(new URL(resourceUrl).href);
  });
});

const postgres = testDrivers.find((d) => d.kind === 'postgres');

describe.skipIf(!postgres?.enabled)('/mcp on Postgres: a real storage timeout is a 401, never 500 (G6, WS8.32)', () => {
  /** An app on its own Postgres schema whose storage has these timeouts, and a second connection to lock it. */
  async function startPostgresApp(timeouts: { pgStatementTimeoutMs: number; pgQueryTimeoutMs: number }) {
    const handle = await (postgres as NonNullable<typeof postgres>).open();
    const connectionString = handle.connectionString as string;
    factory.override = () => handle.reopen({ timeouts });
    const started = await startApp({ storageDriver: 'postgres', databaseUrl: connectionString });
    const pg = (await import('pg')).default;
    const locker = new pg.Client({ connectionString });
    await locker.connect();
    return { ...started, locker };
  }

  it.each([
    ['the server cancels the statement (statement_timeout)', { pgStatementTimeoutMs: 300, pgQueryTimeoutMs: 10_000 }, /statement timeout/],
    ['the client gives up (query_timeout)', { pgStatementTimeoutMs: 20_000, pgQueryTimeoutMs: 300 }, /Query read timeout/],
  ])('%s', async (_name, timeouts, logged) => {
    const { app, storage, locker } = await startPostgresApp(timeouts);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const token = await seedToken(storage);
      expect((await mcp(app, `Bearer ${token}`)).status).not.toBe(401);

      // Hold a lock that blocks the token lookup itself.
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE access_tokens IN ACCESS EXCLUSIVE MODE');
      const startedAt = Date.now();
      const res = await mcp(app, `Bearer ${token}`);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expectChallenge(res);
      expect(res.text).not.toMatch(/timeout|server_error/);
      expect(errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(logged);

      // Once the lock is gone, the same token verifies again.
      await locker.query('ROLLBACK');
      expect((await mcp(app, `Bearer ${token}`)).status).not.toBe(401);
    } finally {
      await locker.end();
    }
  });
});
