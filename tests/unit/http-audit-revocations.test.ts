/**
 * #60b (D-7a), through the real app (buildHttpApp) on every storage driver:
 * each revocation of an MCP connection is exactly one audit row, and nothing
 * else in the OAuth flows writes one.
 *
 *   - /revoke, with the refresh token or the access token: `revoked`;
 *   - a spent refresh token presented again past #64a's window, or by
 *     another client (grant-guard): `revoked_reuse`;
 *   - the account tools' AccountStore (revokeUserFamily,
 *     deleteTokenFamiliesForClient): `revoked`, with the caller's AuditLog;
 *   - none for a sign-in, a refresh, a retry inside the refresh window, a
 *     repeated revocation of a grant already gone, or an account erase.
 *
 * The library's own reuse check and the compare-and-set replay are in
 * tests/unit/auth/oidc/provider.test.ts (they need a race this app's
 * grant-guard closes). No row holds a token. YNAB is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { AuditRecord, Storage } from '../../src/storage/types.js';

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
import { REFRESH_GRACE_WINDOW_MS } from '../../src/auth/refresh-grace.js';
import { createAccountStore } from '../../src/storage/account-store.js';
import { AuditLog } from '../../src/services/audit-log.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { testDrivers, cleanupDrivers, type DriverHandle } from './helpers/storage-drivers.js';
import { bearer, mcpInitialize } from './helpers/mcp-call.js';
import { PUBLIC_URL, RESOURCE, CookieJar, browserFlow, exchangeCode, pkcePair, refresh, registerClient } from './helpers/oidc-app.js';

const USER = 'ynab-user-1';
const ENCRYPTION_KEY = randomBytes(32).toString('base64');
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

function advance(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

/** Every audit row, every column, as the database holds it. */
async function rawRows(h: DriverHandle, storage: Storage): Promise<unknown[]> {
  if (h.sql) return h.sql('SELECT * FROM audit_log');
  return storage.listAuditEntries(USER, {}, 1000);
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`revocations in the audit log (#60b): ${driver.name}`, () => {
    async function start(h: DriverHandle): Promise<{ app: Express; storage: Storage }> {
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

    /** A signed-in client: its pair and its grant id. */
    async function signIn(app: Express, storage: Storage) {
      const client = await registerClient(app);
      const { verifier, challenge } = pkcePair();
      const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge });
      const res = await exchangeCode(app, { clientId: client.clientId, code: flow.params.get('code') as string, verifier });
      expect(res.status).toBe(200);
      const connections = await storage.listConnections(USER);
      const grantId = connections.find((c) => c.clientId === client.clientId)?.familyId as string;
      expect(grantId).toBeDefined();
      return {
        clientId: client.clientId,
        grantId,
        access: res.body.access_token as string,
        refreshToken: res.body.refresh_token as string,
      };
    }

    const revocations = async (storage: Storage): Promise<AuditRecord[]> =>
      storage.listAuditEntries(USER, { operation: 'revoke' }, 100);

    /** Wait for the rows the library's event writes in the background, then for anything late. */
    async function settled(storage: Storage, n: number): Promise<AuditRecord[]> {
      await vi.waitFor(async () => expect(await revocations(storage)).toHaveLength(n), { timeout: 3000, interval: 20 });
      await new Promise((r) => setTimeout(r, 100));
      return revocations(storage);
    }

    function expectNoTokens(stored: unknown, ...tokens: string[]): void {
      const text = JSON.stringify(stored);
      for (const t of tokens) expect(text).not.toContain(t);
    }

    it('a sign-in and refreshes record nothing; /revoke with the refresh token records one row', async () => {
      const h = await driver.open();
      const { app, storage } = await start(h);
      const s = await signIn(app, storage);
      const r1 = await refresh(app, { clientId: s.clientId, refreshToken: s.refreshToken });
      expect(r1.status).toBe(200);
      const r2 = await refresh(app, { clientId: s.clientId, refreshToken: r1.body.refresh_token as string });
      expect(r2.status).toBe(200);
      expect(await storage.listAuditEntries(USER, {}, 100)).toEqual([]);

      const res = await request(app).post('/revoke').type('form').send({ token: r2.body.refresh_token, client_id: s.clientId });
      expect(res.status).toBe(200);
      const [row, ...rest] = await settled(storage, 1);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        userId: USER,
        clientId: s.clientId,
        familyId: s.grantId,
        operation: 'revoke',
        resourceType: 'grant',
        resourceId: s.grantId,
        outcome: 'revoked',
        tool: undefined,
        budgetId: undefined,
      });
      // The connection is gone.
      expect((await mcpInitialize(app, bearer(r2.body.access_token as string))).status).toBe(401);
      // Revoking it again finds nothing: no second row.
      await request(app).post('/revoke').type('form').send({ token: r2.body.refresh_token, client_id: s.clientId });
      await request(app).post('/revoke').type('form').send({ token: r2.body.access_token, client_id: s.clientId });
      expect(await settled(storage, 1)).toHaveLength(1);
      expectNoTokens(await rawRows(h, storage), s.refreshToken, s.access, r2.body.refresh_token as string, r2.body.access_token as string);
    });

    it('/revoke with the access token ends the whole grant and records one row', async () => {
      const h = await driver.open();
      const { app, storage } = await start(h);
      const s = await signIn(app, storage);
      const res = await request(app).post('/revoke').type('form').send({ token: s.access, client_id: s.clientId });
      expect(res.status).toBe(200);
      const rows = await settled(storage, 1);
      expect(rows[0]).toMatchObject({ resourceId: s.grantId, outcome: 'revoked', clientId: s.clientId });
      // The refresh token went with it (the adapter ends the grant whatever the library's policy).
      expect((await refresh(app, { clientId: s.clientId, refreshToken: s.refreshToken })).body.error).toBe('invalid_grant');
      // That refusal found nothing to revoke: still one row.
      expect(await settled(storage, 1)).toHaveLength(1);
      expectNoTokens(await rawRows(h, storage), s.refreshToken, s.access);
    });

    it('a retry inside the refresh window records nothing; past it, reuse records one row', async () => {
      const h = await driver.open();
      const { app, storage } = await start(h);
      const s = await signIn(app, storage);
      const rotated = await refresh(app, { clientId: s.clientId, refreshToken: s.refreshToken });
      expect(rotated.status).toBe(200);
      // #64a: the identical retry gets the same pair; nothing is revoked.
      const retry = await refresh(app, { clientId: s.clientId, refreshToken: s.refreshToken });
      expect(retry.status).toBe(200);
      expect(await storage.listAuditEntries(USER, {}, 100)).toEqual([]);

      advance(REFRESH_GRACE_WINDOW_MS + 1000);
      const reuse = await refresh(app, { clientId: s.clientId, refreshToken: s.refreshToken });
      expect(reuse.body.error).toBe('invalid_grant');
      const rows = await settled(storage, 1);
      expect(rows[0]).toMatchObject({
        userId: USER,
        clientId: s.clientId,
        familyId: s.grantId,
        resourceType: 'grant',
        resourceId: s.grantId,
        operation: 'revoke',
        outcome: 'revoked_reuse',
      });
      // Presented again: the grant is already gone, nothing more is revoked or recorded.
      await refresh(app, { clientId: s.clientId, refreshToken: s.refreshToken });
      await refresh(app, { clientId: s.clientId, refreshToken: rotated.body.refresh_token as string });
      expect(await settled(storage, 1)).toHaveLength(1);
      expectNoTokens(await rawRows(h, storage), s.refreshToken, rotated.body.refresh_token as string, rotated.body.access_token as string);
    });

    it("another client presenting the credential records one row naming the presenting client, not the victim's grant", async () => {
      const h = await driver.open();
      const { app, storage } = await start(h);
      const s = await signIn(app, storage);
      const other = await registerClient(app);
      const res = await refresh(app, { clientId: other.clientId, refreshToken: s.refreshToken });
      expect(res.body.error).toBe('invalid_grant');
      const rows = await settled(storage, 1);
      expect(rows[0]).toMatchObject({
        userId: USER,
        clientId: other.clientId,
        familyId: undefined,
        resourceId: s.grantId,
        outcome: 'revoked_reuse',
      });
      expect((await mcpInitialize(app, bearer(s.access))).status).toBe(401);
      expectNoTokens(await rawRows(h, storage), s.refreshToken, s.access);
    });

    it("the account tools' revocations through AccountStore record one row each, with the caller", async () => {
      const h = await driver.open();
      const { app, storage } = await start(h);
      const a = await signIn(app, storage);
      const b = await signIn(app, storage);
      const c = await signIn(app, storage);
      const generation = (await storage.getUser(USER))?.createdAt ?? 0;
      const auditLog = new AuditLog(storage, { userId: USER, clientId: a.clientId, familyId: a.grantId, requestId: 'req-tool', generation });
      const accounts = createAccountStore(storage, auditLog);

      await auditLog.runCall('ynab_revoke_connection', async () => {
        expect(await accounts.revokeUserFamily(USER, b.grantId)).toBe(true);
        // Already gone, unknown, or another user's: false, and nothing recorded.
        expect(await accounts.revokeUserFamily(USER, b.grantId)).toBe(false);
        expect(await accounts.revokeUserFamily(USER, 'no-such-grant')).toBe(false);
        expect(await accounts.revokeUserFamily('someone-else', a.grantId)).toBe(false);
      });
      expect(await accounts.deleteTokenFamiliesForClient(USER, c.clientId)).toBe(1);
      expect(await accounts.deleteTokenFamiliesForClient(USER, c.clientId)).toBe(0);

      const rows = (await revocations(storage)).reverse();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        userId: USER,
        clientId: a.clientId,
        familyId: a.grantId,
        requestId: 'req-tool',
        tool: 'ynab_revoke_connection',
        resourceType: 'grant',
        resourceId: b.grantId,
        outcome: 'revoked',
      });
      expect(rows[1]).toMatchObject({ clientId: a.clientId, resourceType: 'client', resourceId: c.clientId, outcome: 'revoked' });
      // They went through storage, not the library: no event row on top.
      expect(await settled(storage, 2)).toHaveLength(2);
      expect(await storage.listAuditEntries('someone-else', {}, 10)).toEqual([]);
      expectNoTokens(await rawRows(h, storage), a.refreshToken, b.refreshToken, c.refreshToken, b.access);
    });

    it('an account erase (ynab_disconnect) records no revocation and leaves no row', async () => {
      const h = await driver.open();
      const { app, storage } = await start(h);
      const s = await signIn(app, storage);
      await request(app).post('/revoke').type('form').send({ token: s.refreshToken, client_id: s.clientId });
      await settled(storage, 1);
      const t = await signIn(app, storage);
      const generation = (await storage.getUser(USER))?.createdAt ?? 0;
      await createAccountStore(storage, new AuditLog(storage, { userId: USER, generation })).deleteUserData(USER);
      expect(await storage.listAuditEntries(USER, {}, 100)).toEqual([]);
      expect(await rawRows(h, storage)).toEqual([]);
      // A credential of the erased account presented afterwards finds nothing: still no row.
      await refresh(app, { clientId: t.clientId, refreshToken: t.refreshToken });
      await new Promise((r) => setTimeout(r, 100));
      expect(await rawRows(h, storage)).toEqual([]);
    });
  });
}
