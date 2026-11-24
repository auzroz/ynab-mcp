/**
 * #64a (OAUTH-15): the 60 s refresh idempotency window, through the real app
 * (buildHttpApp) on every storage driver, with two replicas over one database
 * where the driver has more than one connection. YNAB is mocked.
 *
 *   - an identical retry inside the window, by the same client, before the
 *     successor is used, gets the same successor pair and revokes nothing;
 *   - past the window, from another client, with another scope or resource,
 *     after the successor access token was used at /mcp, or after the
 *     successor refresh token was used, the retry revokes the grant (today's
 *     reuse detection, unchanged);
 *   - concurrent retries, on two replicas, get the one pair: never a second
 *     live chain;
 *   - the stored record holds no token in the clear, goes with its grant and
 *     its user, and is swept once expired;
 *   - no refusal carries a token.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { OAuthRowRecord, Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7_200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'ya2', refreshToken: 'yr2', expiresAt: Date.now() + 7_200_000 })),
  };
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
import { REFRESH_GRACE_WINDOW_MS, refreshGraceKey } from '../../src/auth/refresh-grace.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER, testKey } from './helpers/token-hasher.js';
import { testDrivers, cleanupDrivers, type DriverHandle } from './helpers/storage-drivers.js';
import { bearer, mcpInitialize } from './helpers/mcp-call.js';
import { PUBLIC_URL, RESOURCE, CookieJar, browserFlow, exchangeCode, pkcePair, refresh, registerClient } from './helpers/oidc-app.js';

const USER = 'ynab-user-1';

interface Pair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

const handles: HttpApp[] = [];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const h of handles.splice(0)) await h.mcp.close();
  factory.open = undefined;
  vi.restoreAllMocks();
  await cleanupDrivers();
});

/** Move the clock (Date only: timers stay real, so I/O still runs). */
function advance(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

/** Every `oauth_rows` row: key, model, payload, grant and consumed, from any driver. */
async function rowsOf(h: DriverHandle): Promise<Array<{ key: string; model: string; payload: string; grantId: string | null; consumedAt: unknown }>> {
  if (h.sql) {
    return (await h.sql('SELECT key, model, payload, grant_id, consumed_at FROM oauth_rows')).map((r) => ({
      key: String(r['key']),
      model: String(r['model']),
      payload: String(r['payload']),
      grantId: (r['grant_id'] as string | null) ?? null,
      consumedAt: r['consumed_at'],
    }));
  }
  const map = (h.storage as unknown as { oauthRows: Map<string, OAuthRowRecord> }).oauthRows;
  return [...map.values()].map((r) => ({
    key: r.key,
    model: r.model,
    payload: r.payload,
    grantId: r.grantId ?? null,
    consumedAt: r.consumedAt ?? null,
  }));
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`the refresh grace window (${driver.name})`, () => {
    /** One database; each app is a replica with its own storage over it. */
    async function replica(h: DriverHandle): Promise<{ app: Express; storage: Storage }> {
      let storage: Storage | undefined;
      factory.open = async () => {
        storage = await h.reopen();
        return storage;
      };
      const handle = await buildHttpApp(
        makeHttpConfig({
          publicUrl: PUBLIC_URL,
          resourceUrl: RESOURCE,
          readOnly: false,
          authMode: 'oauth',
          oauthClientId: 'ynab-client-id',
          oauthClientSecret: 'ynab-client-secret',
          encryptionKey: ENCRYPTION_KEY,
          tokenPepper: TEST_TOKEN_PEPPER,
          storageDriver: driver.kind,
          sqlitePath: 'opened-by-the-test',
          databaseUrl: h.connectionString ?? 'opened-by-the-test',
        })
      );
      handles.push(handle);
      return { app: handle.app, storage: storage as Storage };
    }

    const ENCRYPTION_KEY = randomBytes(32).toString('base64');

    /** A signed-in client, its first pair, and that pair rotated once (the response the client "lost"). */
    async function rotated(app: Express) {
      const client = await registerClient(app);
      const { verifier, challenge } = pkcePair();
      const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge });
      const first = await exchangeCode(app, { clientId: client.clientId, code: flow.params.get('code') as string, verifier });
      expect(first.status).toBe(200);
      const spent = first.body.refresh_token as string;
      const lost = await refresh(app, { clientId: client.clientId, refreshToken: spent });
      expect(lost.status).toBe(200);
      return { clientId: client.clientId, spent, firstAccess: first.body.access_token as string, successor: lost.body as Pair };
    }

    async function expectRevoked(app: Express, successor: Pair, clientId: string): Promise<void> {
      expect((await mcpInitialize(app, bearer(successor.access_token))).status).toBe(401);
      const next = await refresh(app, { clientId, refreshToken: successor.refresh_token });
      expect(next.status).toBe(400);
      expect(next.body.error).toBe('invalid_grant');
    }

    function expectNoTokens(text: string, ...tokens: string[]): void {
      for (const t of tokens) expect(text).not.toContain(t);
    }

    it('an identical retry inside the window gets the same pair, and nothing is revoked', async () => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);

      const retry = await refresh(app, { clientId, refreshToken: spent });
      expect(retry.status).toBe(200);
      expect(retry.headers['cache-control']).toBe('no-store');
      expect(retry.body.access_token).toBe(successor.access_token);
      expect(retry.body.refresh_token).toBe(successor.refresh_token);
      expect(retry.body.token_type).toBe(successor.token_type);
      expect(retry.body.scope).toBe(successor.scope);
      expect(retry.body.expires_in).toBeLessThanOrEqual(successor.expires_in);
      expect(retry.body.expires_in).toBeGreaterThan(successor.expires_in - 60);

      // The pair works, and its refresh token rotates normally.
      expect((await mcpInitialize(app, bearer(successor.access_token))).status).toBe(200);
      const next = await refresh(app, { clientId, refreshToken: successor.refresh_token });
      expect(next.status).toBe(200);
      expect((await mcpInitialize(app, bearer(next.body.access_token as string))).status).toBe(200);
    });

    it('a retry with the resource in another spelling of the same URL is still identical', async () => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);
      const retry = await refresh(app, { clientId, refreshToken: spent, resource: `${RESOURCE}/` });
      expect(retry.status).toBe(200);
      expect(retry.body.refresh_token).toBe(successor.refresh_token);
    });

    it('a retry on another replica gets the same pair (the record is in storage, not in a process)', async () => {
      const h = await driver.open();
      const a = await replica(h);
      const b = await replica(h);
      const { clientId, spent, successor } = await rotated(a.app);
      const retry = await refresh(b.app, { clientId, refreshToken: spent });
      expect(retry.status).toBe(200);
      expect(retry.body.refresh_token).toBe(successor.refresh_token);
      expect((await mcpInitialize(b.app, bearer(successor.access_token))).status).toBe(200);
    });

    it('a retry past the window revokes the grant', async () => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);
      advance(REFRESH_GRACE_WINDOW_MS + 1_000);
      const retry = await refresh(app, { clientId, refreshToken: spent });
      expect(retry.status).toBe(400);
      expect(retry.body).toEqual({ error: 'invalid_grant', error_description: 'grant request is invalid' });
      expectNoTokens(retry.text, spent, successor.access_token, successor.refresh_token);
      await expectRevoked(app, successor, clientId);
      // The record went with its grant.
      expect((await rowsOf(h)).filter((r) => r.model === 'RefreshGrace')).toEqual([]);
    });

    it('a retry from another client revokes the grant', async () => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);
      const other = await registerClient(app);
      const retry = await refresh(app, { clientId: other.clientId, refreshToken: spent });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe('invalid_grant');
      expectNoTokens(retry.text, spent, successor.access_token, successor.refresh_token);
      await expectRevoked(app, successor, clientId);
    });

    it.each([
      ['a narrower scope', { scope: 'read-only' }],
      ['a foreign resource', { resource: 'https://evil.example/mcp' }],
    ])('a retry with %s is not identical: it revokes the grant', async (_name, change) => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);
      const retry = await refresh(app, { clientId, refreshToken: spent, ...change });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe('invalid_grant');
      expectNoTokens(retry.text, spent, successor.access_token, successor.refresh_token);
      await expectRevoked(app, successor, clientId);
    });

    it('once the successor access token is used at /mcp, a retry revokes (first use recorded once)', async () => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);
      expect((await mcpInitialize(app, bearer(successor.access_token))).status).toBe(200);
      const record = (await rowsOf(h)).find((r) => r.model === 'RefreshGrace');
      const firstUsedAt = (JSON.parse(record?.payload ?? '{}') as { firstUsedAt?: unknown }).firstUsedAt;
      expect(typeof firstUsedAt).toBe('number');
      // A second use doesn't rewrite it.
      expect((await mcpInitialize(app, bearer(successor.access_token))).status).toBe(200);
      const again = (await rowsOf(h)).find((r) => r.model === 'RefreshGrace');
      expect((JSON.parse(again?.payload ?? '{}') as { firstUsedAt?: unknown }).firstUsedAt).toBe(firstUsedAt);

      const retry = await refresh(app, { clientId, refreshToken: spent });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe('invalid_grant');
      await expectRevoked(app, successor, clientId);
    });

    it('once the successor refresh token is used, a retry of the old one revokes', async () => {
      const h = await driver.open();
      const { app } = await replica(h);
      const { clientId, spent, successor } = await rotated(app);
      const next = await refresh(app, { clientId, refreshToken: successor.refresh_token });
      expect(next.status).toBe(200);
      const retry = await refresh(app, { clientId, refreshToken: spent });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe('invalid_grant');
      expect((await mcpInitialize(app, bearer(next.body.access_token as string))).status).toBe(401);
    });

    it('two concurrent retries on two replicas get the one pair: no second live chain', async () => {
      const h = await driver.open();
      const a = await replica(h);
      const b = await replica(h);
      const { clientId, spent, successor } = await rotated(a.app);
      const [r1, r2] = await Promise.all([
        refresh(a.app, { clientId, refreshToken: spent }),
        refresh(b.app, { clientId, refreshToken: spent }),
      ]);
      for (const r of [r1, r2]) {
        expect(r.status).toBe(200);
        expect(r.body.refresh_token).toBe(successor.refresh_token);
        expect(r.body.access_token).toBe(successor.access_token);
      }
      // One live (unconsumed) refresh token in the grant: the successor.
      const rows = await rowsOf(h);
      const live = rows.filter((r) => r.model === 'RefreshToken' && (r.consumedAt === null || r.consumedAt === undefined));
      expect(live.map((r) => r.key)).toEqual([testKey('refresh', successor.refresh_token)]);
      // Two concurrent first uses of the successor: never two different live pairs. Either the
      // second is a retry of a recorded rotation (the same pair), or it loses the consume and
      // the grant is revoked (ADR-0002 D4's race), leaving no live token at all.
      const [n1, n2] = await Promise.all([
        refresh(a.app, { clientId, refreshToken: successor.refresh_token }),
        refresh(b.app, { clientId, refreshToken: successor.refresh_token }),
      ]);
      const issued = new Set([n1, n2].filter((r) => r.status === 200).map((r) => r.body.refresh_token as string));
      expect(issued.size).toBeLessThanOrEqual(1);
      const stillLive = (await rowsOf(h)).filter(
        (r) => r.model === 'RefreshToken' && (r.consumedAt === null || r.consumedAt === undefined)
      );
      if ([n1, n2].every((r) => r.status === 200)) {
        expect(stillLive.map((r) => r.key)).toEqual([...issued].map((t) => testKey('refresh', t)));
      } else {
        expect(stillLive).toEqual([]);
      }
    });

    it('the record holds no token in the clear, and goes with the user on account deletion', async () => {
      const h = await driver.open();
      const { app, storage } = await replica(h);
      const { spent, firstAccess, successor } = await rotated(app);
      const rows = await rowsOf(h);
      const grace = rows.filter((r) => r.model === 'RefreshGrace');
      expect(grace).toHaveLength(1);
      expect(grace[0]?.key).toBe(refreshGraceKey(grace[0]?.grantId as string));
      const dump = JSON.stringify(rows);
      expectNoTokens(dump, spent, firstAccess, successor.access_token, successor.refresh_token);

      await storage.deleteUserData(USER);
      expect((await rowsOf(h)).filter((r) => r.model === 'RefreshGrace')).toEqual([]);
    });

    it('the sweep deletes the record once its window is over', async () => {
      const h = await driver.open();
      const { app, storage } = await replica(h);
      await rotated(app);
      expect((await rowsOf(h)).filter((r) => r.model === 'RefreshGrace')).toHaveLength(1);
      advance(REFRESH_GRACE_WINDOW_MS + 1_000);
      await storage.sweepExpired();
      expect((await rowsOf(h)).filter((r) => r.model === 'RefreshGrace')).toEqual([]);
    });

    it('a record that could not be stored only costs the grace: the response still goes out, a retry revokes', async () => {
      const h = await driver.open();
      const { app, storage } = await replica(h);
      const client = await registerClient(app);
      const { verifier, challenge } = pkcePair();
      const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge });
      const first = await exchangeCode(app, { clientId: client.clientId, code: flow.params.get('code') as string, verifier });
      const original = storage.compareAndSetOAuthRow.bind(storage);
      const cas = vi.spyOn(storage, 'compareAndSetOAuthRow').mockImplementation(async (expected, row) => {
        if (row.model === 'RefreshGrace') throw new Error('storage down');
        return original(expected, row);
      });
      const lost = await refresh(app, { clientId: client.clientId, refreshToken: first.body.refresh_token as string });
      expect(lost.status).toBe(200);
      cas.mockRestore();
      const retry = await refresh(app, { clientId: client.clientId, refreshToken: first.body.refresh_token as string });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe('invalid_grant');
    });
  });
}

describe('the verifier makes no grace read past the window', () => {
  it('a successor access token older than 60 s costs one storage read at /mcp', async () => {
    const memory = testDrivers.find((d) => d.kind === 'memory');
    const h = await (memory as NonNullable<typeof memory>).open();
    let storage: Storage | undefined;
    factory.open = async () => {
      storage = await h.reopen();
      return storage;
    };
    const handle = await buildHttpApp(
      makeHttpConfig({
        publicUrl: PUBLIC_URL,
        resourceUrl: RESOURCE,
        readOnly: false,
        authMode: 'oauth',
        oauthClientId: 'ynab-client-id',
        oauthClientSecret: 'ynab-client-secret',
        encryptionKey: randomBytes(32).toString('base64'),
        tokenPepper: TEST_TOKEN_PEPPER,
      })
    );
    handles.push(handle);
    const app = handle.app;
    const client = await registerClient(app);
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge });
    const first = await exchangeCode(app, { clientId: client.clientId, code: flow.params.get('code') as string, verifier });
    const rotatedPair = await refresh(app, { clientId: client.clientId, refreshToken: first.body.refresh_token as string });
    advance(REFRESH_GRACE_WINDOW_MS + 1_000);
    const reads = vi.spyOn(storage as Storage, 'findOAuthRow');
    // The YNAB token refresh is mocked; only the bearer check reads oauth_rows.
    await request(app).post('/mcp').set('Authorization', `Bearer ${rotatedPair.body.access_token as string}`).send({});
    expect(reads.mock.calls.filter(([key]) => String(key).startsWith('RefreshGrace:'))).toEqual([]);
  });
});
