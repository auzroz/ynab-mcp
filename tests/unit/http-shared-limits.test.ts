/**
 * #67 end to end: two app instances (two replicas) on one Postgres database
 * with RATE_LIMIT_STORE=postgres. The user's YNAB budget is spent once between
 * them (three requests an hour: three YNAB calls in all, the fourth refused on
 * either replica); an authorization-server limit counts both replicas'
 * requests; the metadata-document fetch budget is shared; and a database that
 * doesn't answer refuses tool calls (`upstream_unavailable`, nothing sent to
 * YNAB) and rate-limited AS requests (429, Retry-After 5) instead of letting
 * them through on a per-process budget. The write cap (#61c) is shared too:
 * exactly the cap in writes between the replicas, the refusal audited, a
 * database that doesn't answer refuses the write before YNAB, and the erase
 * removes the user's row. YNAB is mocked: its token refresh, and the API
 * through a stubbed fetch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Request } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'ynab-access', refreshToken: 'ynab-refresh-2', expiresAt: Date.now() + 7_200_000 })),
  };
});

const factory = vi.hoisted(() => ({
  /** Opens the storage the next app gets (a replica on the test's database). */
  open: undefined as (() => Promise<Storage>) | undefined,
  opened: [] as Storage[],
}));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      const storage = factory.open ? await factory.open() : await actual.createStorage(...args);
      factory.opened.push(storage);
      return storage;
    },
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { Encryptor, refreshTokenContext } from '../../src/crypto.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { plantAccessToken } from './helpers/oauth-state.js';
import { bearer, mcpConnect } from './helpers/mcp-call.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from './helpers/storage-drivers.js';
import { CLIENT_AUTH_ROUTE_RATE_LIMIT } from '../../src/auth/as-router.js';
import { createClientIdMetadataDocuments, FETCH_RATE_LIMIT } from '../../src/auth/client-id-metadata.js';
import { sharedLimiterStores } from '../../src/middleware/shared-limiter-store.js';
import type { HttpConfig } from '../../src/config/environment.js';

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const USER = 'ynab-user-1';
const encryptionKey = randomBytes(32).toString('base64');

let fetchSpy: ReturnType<typeof vi.fn>;
const apps: HttpApp[] = [];

function stubYnab(): void {
  // One body for every call these tests make (ynab_get_user, ynab_create_payee).
  const body = { data: { user: { id: USER }, payee: { id: '33333333-3333-4333-8333-333333333333', name: 'Corner Shop' } } };
  fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchSpy);
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.mcp.close();
  factory.open = undefined;
  factory.opened = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanupDrivers();
});

function config(overrides: Partial<HttpConfig>): HttpConfig {
  return makeHttpConfig({
    publicUrl: PUBLIC_URL,
    resourceUrl: RESOURCE,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey,
    tokenPepper: TEST_TOKEN_PEPPER,
    storageDriver: 'postgres',
    rateLimitStore: 'postgres',
    ...overrides,
  });
}

const postgres = testDrivers.find((d) => d.kind === 'postgres')!;

/** Two replicas of the app on one database; the user and a token for each replica's client. */
async function twoReplicas(
  overrides: Partial<HttpConfig> = {},
  storageOptions: Parameters<DriverHandle['reopen']>[0] = undefined,
  scope: 'read-only' | 'read-write' = 'read-only'
): Promise<{ a: HttpApp; b: HttpApp; tokens: string[]; handle: DriverHandle }> {
  const handle = await postgres.open();
  factory.open = () => handle.reopen(storageOptions);
  const cfg = config({ databaseUrl: handle.connectionString, ...overrides });
  const a = await buildHttpApp(cfg);
  const b = await buildHttpApp(cfg);
  apps.push(a, b);
  await handle.storage.upsertUser({
    userId: USER,
    grantedScope: scope,
    encryptedRefreshToken: new Encryptor(encryptionKey).encrypt('ynab-refresh-1', refreshTokenContext(USER)),
    updatedAt: Date.now(),
  });
  const tokens: string[] = [];
  for (const clientId of ['client-a', 'client-b']) {
    tokens.push(
      await plantAccessToken(handle.storage, {
        clientId,
        userId: USER,
        scopes: scope === 'read-write' ? ['read-only', 'read-write'] : ['read-only'],
        expiresAt: Date.now() + 3_600_000,
        resource: RESOURCE,
        grantedScope: scope,
      })
    );
  }
  return { a, b, tokens, handle };
}

const errorType = (r: { isError: boolean; text: string }): string | undefined =>
  r.isError ? (JSON.parse(r.text) as { type?: string }).type : undefined;

describe.skipIf(!postgres.enabled)('RATE_LIMIT_STORE=postgres across two replicas', () => {
  it("one YNAB budget per user: three an hour is three YNAB calls in all, the fourth refused on either replica", async () => {
    stubYnab();
    const { a, b, tokens } = await twoReplicas({ rateLimitPerHour: 3, rateLimitMaxWaitMs: 0 });
    const onA = await mcpConnect(a.app, bearer(tokens[0]!));
    const onB = await mcpConnect(b.app, bearer(tokens[1]!));
    expect(errorType(await onA.callTool('ynab_get_user'))).toBeUndefined();
    expect(errorType(await onB.callTool('ynab_get_user'))).toBeUndefined();
    expect(errorType(await onA.callTool('ynab_get_user'))).toBeUndefined();
    const refusedB = await onB.callTool('ynab_get_user');
    const refusedA = await onA.callTool('ynab_get_user');
    for (const refused of [refusedB, refusedA]) {
      const body = JSON.parse(refused.text) as { type: string; retry_after_seconds: number };
      expect(body.type).toBe('rate_limited');
      // Three an hour: the next token in about 20 minutes.
      expect(body.retry_after_seconds).toBeGreaterThan(1_190);
      expect(body.retry_after_seconds).toBeLessThanOrEqual(1_200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // The status tool (no YNAB call) shows the shared budget on the other replica.
    const status = JSON.parse((await onB.callTool('ynab_rate_limit_status')).text) as {
      rate_limit: { available_requests: number; store: string };
      usage: { requests_last_hour: number };
    };
    expect(status.rate_limit).toMatchObject({ available_requests: 0, store: 'postgres' });
    // This replica's own sends.
    expect(status.usage.requests_last_hour).toBe(1);
  });

  it('one write cap per user: exactly YNAB_WRITE_LIMIT_PER_HOUR writes between the replicas, the refusal audited; down fails closed; the erase removes it', async () => {
    stubYnab();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { a, b, tokens, handle } = await twoReplicas(
      { writeLimitPerHour: 3, readOnly: false, allowWrite: true },
      { timeouts: { pgLimiterStatementTimeoutMs: 200, pgLimiterQueryTimeoutMs: 1_000 } },
      'read-write'
    );
    const sql = handle.sql!;
    const onA = await mcpConnect(a.app, bearer(tokens[0]!));
    const onB = await mcpConnect(b.app, bearer(tokens[1]!));
    const write = (c: typeof onA) => c.callTool('ynab_create_payee', { budget_id: '11111111-1111-4111-8111-111111111111', name: 'Corner Shop' });
    const types = [];
    for (const c of [onA, onB, onA, onB, onA]) types.push(errorType(await write(c)));
    expect(types).toEqual([undefined, undefined, undefined, 'write_limit_exceeded', 'write_limit_exceeded']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // The first refusal of the episode is audited once, on whichever replica it happened.
    await vi.waitFor(async () => {
      const outcomes = (await sql('SELECT outcome FROM audit_log WHERE user_id = $1 ORDER BY id', [USER])).map((r) => r['outcome']);
      expect(outcomes).toEqual(['success', 'success', 'success', 'denied_write_limit']);
    });

    // The database doesn't answer: the write is refused before YNAB, and recorded as an error.
    await sql('DELETE FROM rate_limit_writes');
    const pg = (await import('pg')).default;
    const locker = new pg.Client({ connectionString: handle.connectionString });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE rate_limit_writes IN ACCESS EXCLUSIVE MODE');
      const startedAt = Date.now();
      const refused = JSON.parse((await write(onB)).text) as Record<string, unknown>;
      expect(refused).toMatchObject({ error: true, type: 'upstream_unavailable', retry_after_seconds: 5 });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
    await vi.waitFor(async () => {
      const [last] = await sql('SELECT outcome FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [USER]);
      expect(last?.['outcome']).toBe('error');
    });

    // The erase removes the user's write-cap row (and bucket).
    expect(errorType(await write(onA))).toBeUndefined();
    expect(await sql('SELECT user_id FROM rate_limit_writes')).toEqual([{ user_id: USER }]);
    expect(await handle.storage.deleteUserData(USER)).toBe(true);
    expect(await sql('SELECT user_id FROM rate_limit_writes')).toEqual([]);
    expect(await sql('SELECT user_id FROM rate_limit_buckets')).toEqual([]);
  });

  it('an authorization-server limit counts both replicas: /token per (client_id, address)', async () => {
    const { a, b } = await twoReplicas();
    const token = (app: HttpApp) =>
      request(app.app).post('/token').type('form').send({ grant_type: 'client_credentials', client_id: 'shared-client' });
    for (let i = 0; i < CLIENT_AUTH_ROUTE_RATE_LIMIT; i++) {
      expect((await token(i % 2 === 0 ? a : b)).status).not.toBe(429);
    }
    const over = await token(a);
    expect(over.status).toBe(429);
    expect((await token(b)).status).toBe(429);
    // Another client_id from the same address still has its budget.
    expect((await request(b.app).post('/token').type('form').send({ grant_type: 'client_credentials', client_id: 'other' })).status).not.toBe(429);
  });

  it('the metadata-document fetch budget is shared per client address', async () => {
    const handle = await postgres.open();
    const other = await handle.reopen();
    const hooks = [handle.storage, other].map((s) =>
      createClientIdMetadataDocuments({
        policy: { privateUseSchemes: [] },
        keyOptions: { trustCfConnectingIp: false },
        limiterStore: sharedLimiterStores(s.sharedLimits!()),
      })
    );
    const fromIp = (i: number, ip: string, url: string): Promise<boolean> =>
      new Promise((resolve, reject) => {
        const req = { ip, header: () => undefined, socket: {} } as unknown as Request;
        hooks[i % 2]!.requesterContext(req, {} as never, () => {
          hooks[i % 2]!.feature.allowFetch(undefined, url).then(resolve, reject);
        });
      });
    for (let i = 0; i < FETCH_RATE_LIMIT; i++) {
      expect(await fromIp(i, '203.0.113.9', `https://client.example/c${i}.json`)).toBe(true);
    }
    expect(await fromIp(0, '203.0.113.9', 'https://client.example/over.json')).toBe(false);
    expect(await fromIp(1, '203.0.113.9', 'https://client.example/over2.json')).toBe(false);
    expect(await fromIp(1, '198.51.100.1', 'https://client.example/elsewhere.json')).toBe(true);
  });

  it('a database that does not answer fails closed: tool calls get upstream_unavailable and reach no YNAB, AS limits answer 429', async () => {
    stubYnab();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { a, b, tokens, handle } = await twoReplicas(
      { rateLimitMaxWaitMs: 0 },
      { timeouts: { pgLimiterStatementTimeoutMs: 200, pgLimiterQueryTimeoutMs: 1_000 } }
    );
    const onA = await mcpConnect(a.app, bearer(tokens[0]!));
    expect(errorType(await onA.callTool('ynab_get_user'))).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const pg = (await import('pg')).default;
    const locker = new pg.Client({ connectionString: handle.connectionString });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE rate_limit_buckets, rate_limit_hits IN ACCESS EXCLUSIVE MODE');
      const startedAt = Date.now();
      const refused = JSON.parse((await onA.callTool('ynab_get_user')).text) as Record<string, unknown>;
      expect(refused).toMatchObject({ error: true, type: 'upstream_unavailable', retry_after_seconds: 5 });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const limited = await request(b.app).post('/token').type('form').send({ grant_type: 'client_credentials', client_id: 'c' });
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBe('5');
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
    // Once it answers again, so do the limiters.
    expect(errorType(await onA.callTool('ynab_get_user'))).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('RATE_LIMIT_STORE=postgres without Postgres', () => {
  it('refuses to build the app rather than use per-process limits', async () => {
    await expect(buildHttpApp(makeHttpConfig({ rateLimitStore: 'postgres' }))).rejects.toThrow(
      /RATE_LIMIT_STORE=postgres requires/
    );
    await expect(
      buildHttpApp(config({ storageDriver: 'memory', databaseUrl: undefined }))
    ).rejects.toThrow(/RATE_LIMIT_STORE=postgres requires STORAGE_DRIVER=postgres/);
  });
});
