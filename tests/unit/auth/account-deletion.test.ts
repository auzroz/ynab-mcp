/**
 * Account erasure and retention end to end (#53a, #54a, G11, G12), on every
 * storage driver: the YNAB refresh write-back racing an erase or a re-consent
 * (barrier mocks around the YNAB call, never sleeps), the session's pinned
 * account generation, and at the token endpoint (oidc-provider over the
 * adapter, ADR-0002 D4): a code or tokens issued before an erase refused after
 * it, and refresh token expiry. Only the YNAB network calls are mocked. The
 * adapter's own deletion rules (deleteUserData over oauth_rows and the 0.4.x
 * tables, in one step) are in tests/unit/storage/oauth-adapter-conformance.test.ts.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>('../../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

import type { Storage } from '../../../src/storage/types.js';
import { Encryptor } from '../../../src/crypto.js';
import { YnabTokenResolver } from '../../../src/auth/user-session.js';
import { YnabAuthError } from '../../../src/utils/errors.js';
import { DEFAULT_RETENTION } from '../../../src/auth/retention-defaults.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { expectInvalidToken } from '../helpers/invalid-token.js';
import {
  CookieJar,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  oauthRowsOf,
  pkcePair,
  refresh,
  registerClient,
  type OidcTestApp,
} from '../helpers/oidc-app.js';

const refreshMock = vi.mocked(ynabOauth.refreshAccessToken);

/** A promise and the function that resolves it: one side waits, the other opens it. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** The next YNAB refresh stops inside the YNAB call until `release` opens. */
function holdNextRefresh(refreshToken: string): { entered: Promise<void>; release: () => void } {
  const entered = barrier();
  const release = barrier();
  refreshMock.mockImplementationOnce(async () => {
    entered.open();
    await release.wait;
    return { accessToken: `ya-${refreshToken}`, refreshToken, expiresAt: Date.now() + 3_600_000 };
  });
  return { entered: entered.wait, release: release.open };
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`account erasure and retention: ${driver.name}`, () => {
    let h: DriverHandle;
    let storage: Storage;
    let encryptor: Encryptor;
    let resolver: YnabTokenResolver;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      refreshMock.mockImplementation(async () => ({
        accessToken: 'ya-default',
        refreshToken: `yr-${randomUUID()}`,
        expiresAt: Date.now() + 3_600_000,
      }));
      h = await driver.open();
      storage = h.storage;
      encryptor = new Encryptor(randomBytes(32).toString('base64'));
      resolver = new YnabTokenResolver(storage, encryptor, { clientId: 'cid', clientSecret: 'sec' });
    });

    afterEach(async () => {
      errorSpy.mockRestore();
      vi.useRealTimers();
      await cleanupDrivers();
    });

    async function connect(userId: string, ynabRefresh = 'yr0'): Promise<void> {
      await storage.upsertUser({
        userId,
        grantedScope: 'read-write',
        encryptedRefreshToken: encryptor.encrypt(ynabRefresh),
        updatedAt: Date.now(),
      });
    }

    describe('YNAB refresh write-back', () => {
      it('a refresh in flight during the erase leaves no users row', async () => {
        await connect('u');
        const held = holdNextRefresh('yr-after-erase');
        const resolving = resolver.resolve('u');
        await held.entered;
        await storage.deleteUserData('u');
        held.release();

        await expect(resolving).rejects.toThrow(/re-authorize/);
        expect(await storage.getUser('u')).toBeUndefined();
        for (const [table, n] of Object.entries(await h.userRows('u'))) expect(n, table).toBe(0);
        // Nothing cached either: the next call fails the same way.
        await expect(resolver.resolve('u')).rejects.toThrow(/re-authorize/);
      });

      it('a refresh racing a re-consent keeps the newer grant and refreshes from it', async () => {
        await connect('u', 'yr0');
        const created = (await storage.getUser('u'))?.createdAt;
        const held = holdNextRefresh('yr-from-old-grant');
        const resolving = resolver.resolve('u');
        await held.entered;
        await connect('u', 'yr-new-grant'); // the user consents again meanwhile
        refreshMock.mockResolvedValueOnce({
          accessToken: 'ya-new-grant',
          refreshToken: 'yr-rotated-new-grant',
          expiresAt: Date.now() + 3_600_000,
        });
        held.release();

        await expect(resolving).resolves.toMatchObject({ accessToken: 'ya-new-grant' });
        expect(refreshMock).toHaveBeenCalledTimes(2);
        expect(refreshMock).toHaveBeenLastCalledWith({ clientId: 'cid', clientSecret: 'sec' }, 'yr-new-grant');
        const user = await storage.getUser('u');
        expect(encryptor.decrypt(user?.encryptedRefreshToken ?? '')).toBe('yr-rotated-new-grant');
        expect(user?.createdAt).toBe(created);
      });

      // ADR review D4 (#91): the refresh used to write back the whole record it
      // read first, so a read-only re-consent landing mid-refresh became read-write.
      it('a read-only re-consent during a refresh (same YNAB token) stays read-only', async () => {
        await connect('u', 'yr0'); // read-write
        const before = await storage.getUser('u');
        const held = holdNextRefresh('yr-rotated');
        const resolving = resolver.resolve('u'); // reads the read-write row
        await held.entered;
        // Re-consent changes only the access level; the YNAB token stays as stored.
        await storage.upsertUser({
          userId: 'u',
          grantedScope: 'read-only',
          encryptedRefreshToken: before?.encryptedRefreshToken ?? '',
          updatedAt: Date.now(),
        });
        held.release();

        // The compare-and-set matches (same token): only the token is written.
        await expect(resolving).resolves.toMatchObject({ accessToken: 'ya-yr-rotated', grantedScope: 'read-only' });
        const after = await storage.getUser('u');
        expect(after?.grantedScope).toBe('read-only');
        expect(encryptor.decrypt(after?.encryptedRefreshToken ?? '')).toBe('yr-rotated');
        expect(after?.createdAt).toBe(before?.createdAt);
        expect(refreshMock).toHaveBeenCalledTimes(1);
        // Later calls (from the cache) read the level from the row too.
        await expect(resolver.resolve('u')).resolves.toMatchObject({ grantedScope: 'read-only' });
      });

      it('a read-only re-consent with a new YNAB token during a refresh stays read-only and wins', async () => {
        await connect('u', 'yr0'); // read-write
        const held = holdNextRefresh('yr-from-old-grant');
        const resolving = resolver.resolve('u');
        await held.entered;
        await storage.upsertUser({
          userId: 'u',
          grantedScope: 'read-only',
          encryptedRefreshToken: encryptor.encrypt('yr-read-only-grant'),
          updatedAt: Date.now(),
        });
        refreshMock.mockResolvedValueOnce({
          accessToken: 'ya-read-only-grant',
          refreshToken: 'yr-rotated-read-only-grant',
          expiresAt: Date.now() + 3_600_000,
        });
        held.release();

        // The compare-and-set misses (the token changed): the newer grant wins and is refreshed.
        await expect(resolving).resolves.toMatchObject({
          accessToken: 'ya-read-only-grant',
          grantedScope: 'read-only',
        });
        expect(refreshMock).toHaveBeenCalledTimes(2);
        expect(refreshMock).toHaveBeenLastCalledWith({ clientId: 'cid', clientSecret: 'sec' }, 'yr-read-only-grant');
        const after = await storage.getUser('u');
        expect(after?.grantedScope).toBe('read-only');
        expect(encryptor.decrypt(after?.encryptedRefreshToken ?? '')).toBe('yr-rotated-read-only-grant');
      });

      it('a refresh racing an erase and a new connection does not use the new account', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await connect('u', 'yr0');
        const held = holdNextRefresh('yr-old-account');
        const resolving = resolver.resolve('u');
        await held.entered;
        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u', 'yr-new-account');
        held.release();

        await expect(resolving).rejects.toThrow(/re-authorize/);
        expect(refreshMock).toHaveBeenCalledTimes(1);
        const user = await storage.getUser('u');
        expect(encryptor.decrypt(user?.encryptedRefreshToken ?? '')).toBe('yr-new-account');
      });

      it("never serves the erased account's cached YNAB token to the account that replaced it", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await connect('u');
        refreshMock.mockResolvedValueOnce({
          accessToken: 'ya-old-account',
          refreshToken: 'yr1',
          expiresAt: Date.now() + 3_600_000,
        });
        await expect(resolver.resolve('u')).resolves.toMatchObject({ accessToken: 'ya-old-account' });

        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u', 'yr-new-account');
        refreshMock.mockResolvedValueOnce({
          accessToken: 'ya-new-account',
          refreshToken: 'yr2',
          expiresAt: Date.now() + 3_600_000,
        });
        await expect(resolver.resolve('u')).resolves.toMatchObject({ accessToken: 'ya-new-account' });
        expect(refreshMock).toHaveBeenLastCalledWith({ clientId: 'cid', clientSecret: 'sec' }, 'yr-new-account');
      });

      it("a session pins the account generation: after an erase and a new connection, its calls fail", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await connect('u');
        const getToken = resolver.accessTokenFor('u');
        await expect(getToken()).resolves.toBe('ya-default');

        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u', 'yr-new-account');
        await expect(getToken()).rejects.toBeInstanceOf(YnabAuthError);
        // A new session (a new token function) belongs to the new account.
        await expect(resolver.accessTokenFor('u')()).resolves.toBe('ya-default');
      });
    });

    describe('at the token endpoint (oidc-provider, ADR-0002 D4)', () => {
      let t: OidcTestApp;
      let clientId: string;

      beforeEach(async () => {
        vi.mocked(ynabOauth.exchangeCode).mockImplementation(async () => ({
          accessToken: 'ya',
          refreshToken: 'yr0',
          expiresAt: Date.now() + 3_600_000,
        }));
        vi.mocked(ynabOauth.getYnabUserId).mockResolvedValue('u');
        t = buildOidcTestApp(storage, { encryptor });
        ({ clientId } = await registerClient(t.app));
      });

      /** A sign-in for user `u`: the code the client would redeem, and its PKCE verifier. */
      async function issueCode(): Promise<{ code: string; verifier: string }> {
        const pkce = pkcePair();
        const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge });
        return { code: flow.params.get('code') as string, verifier: pkce.verifier };
      }

      /** No library row of `u` is left, and only the re-created users row. */
      async function expectOnlyNewUserRow(): Promise<void> {
        expect((await oauthRowsOf(h)).filter((r) => r.accountId === 'u')).toEqual([]);
        expect(await storage.listConnections('u')).toEqual([]);
        for (const [table, n] of Object.entries(await h.userRows('u'))) expect(n, table).toBe(table === 'users' ? 1 : 0);
      }

      it('a code issued before the erase is refused after it, even after re-consent', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { code, verifier } = await issueCode();
        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u', 'yr-new-account'); // re-consent (the users row only)

        const res = await exchangeCode(t.app, { clientId, code, verifier });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
        await expectOnlyNewUserRow();
      });

      it('tokens issued before an erase stay dead after the user connects again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { code, verifier } = await issueCode();
        const tokens = await exchangeCode(t.app, { clientId, code, verifier });
        expect(tokens.status).toBe(200);
        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u');

        await expectInvalidToken(t.verifier.verifyAccessToken(tokens.body.access_token as string));
        const res = await refresh(t.app, { clientId, refreshToken: tokens.body.refresh_token as string });
        expect(res.body.error).toBe('invalid_grant');
        await expectOnlyNewUserRow();
      });

      it('an idle refresh token gets invalid_grant without revoking its grant', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { code, verifier } = await issueCode();
        const tokens = await exchangeCode(t.app, { clientId, code, verifier });
        const refreshToken = tokens.body.refresh_token as string;

        vi.setSystemTime(Date.now() + DEFAULT_RETENTION.refreshTokenIdleMs + 1000);
        const revoke = vi.spyOn(storage, 'revokeOAuthGrant');
        expect((await refresh(t.app, { clientId, refreshToken })).body.error).toBe('invalid_grant');
        expect(revoke).not.toHaveBeenCalled();
        // The same answer again: the token expired, it was not reused.
        expect((await refresh(t.app, { clientId, refreshToken })).body.error).toBe('invalid_grant');
        expect(revoke).not.toHaveBeenCalled();
        expect((await oauthRowsOf(h)).some((r) => r.model === 'Grant' && r.accountId === 'u')).toBe(true);
      });
    });
  });
}
