/**
 * Account erasure and retention end to end (#53a, #54a, G11, G12), on every
 * storage driver: the YNAB refresh write-back racing an erase or a re-consent
 * (barrier mocks around the YNAB call, never sleeps), the session's pinned
 * account generation, a code exchange in flight during an erase, and refresh
 * token expiry at the token endpoint. Only the YNAB network calls are mocked.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>('../../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

import type { Storage } from '../../../src/storage/types.js';
import { Encryptor } from '../../../src/crypto.js';
import { YnabTokenResolver } from '../../../src/auth/user-session.js';
import { McpOAuthProvider } from '../../../src/auth/mcp-provider.js';
import { YnabAuthError } from '../../../src/utils/errors.js';
import { DEFAULT_RETENTION } from '../../../src/auth/retention-defaults.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';

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

function refreshOf(tokens: OAuthTokens): string {
  if (tokens.refresh_token === undefined) throw new Error('no refresh token');
  return tokens.refresh_token;
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

    describe('at the token endpoint', () => {
      let provider: McpOAuthProvider;
      let client: OAuthClientInformationFull;

      beforeEach(async () => {
        provider = new McpOAuthProvider({
          storage,
          encryptor,
          ynab: { clientId: 'cid', clientSecret: 'sec' },
          publicUrl: 'https://mcp.example.com',
          allowWrite: true,
          globalReadOnly: false,
          accessTokenTtlSec: 3600,
          authCodeTtlSec: 600,
        });
        client = await provider.clientsStore.registerClient!({
          redirect_uris: ['https://client/cb'],
          client_name: 'Test Client',
        } as OAuthClientInformationFull);
      });

      async function issueCode(userId: string): Promise<string> {
        const code = `code-${randomUUID()}`;
        await storage.saveAuthCode({
          code,
          clientId: client.client_id,
          userId,
          redirectUri: 'https://client/cb',
          codeChallenge: 'chal',
          scopes: ['ynab'],
          expiresAt: Date.now() + 600_000,
          grantedScope: 'read-write',
        });
        return code;
      }

      it('a code exchange in flight during the erase leaves no usable token, even after re-consent', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await connect('u');
        const code = await issueCode('u');
        await provider.challengeForAuthorizationCode(client, code); // spent; tokens not yet saved
        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u', 'yr-new-account'); // re-consent

        await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toBeInstanceOf(InvalidGrantError);
        expect(await storage.listConnections('u')).toEqual([]);
        const rows = await h.userRows('u');
        for (const [table, n] of Object.entries(rows)) {
          expect(n, table).toBe(table === 'users' ? 1 : 0);
        }
      });

      it('tokens issued before an erase stay dead after the user connects again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await connect('u');
        const code = await issueCode('u');
        await provider.challengeForAuthorizationCode(client, code);
        const tokens = await provider.exchangeAuthorizationCode(client, code);
        await storage.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await connect('u');

        await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
        await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
          InvalidGrantError
        );
      });

      it('an idle refresh token gets invalid_grant without revoking its family', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await connect('u');
        const code = await issueCode('u');
        await provider.challengeForAuthorizationCode(client, code);
        const tokens = await provider.exchangeAuthorizationCode(client, code);

        vi.setSystemTime(Date.now() + DEFAULT_RETENTION.refreshTokenIdleMs + 1);
        const revoke = vi.spyOn(storage, 'deleteTokenFamily');
        await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
          InvalidGrantError
        );
        expect(revoke).not.toHaveBeenCalled();
        // The same answer again: the token is gone, not a reuse.
        await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
          InvalidGrantError
        );
        expect(revoke).not.toHaveBeenCalled();
      });
    });
  });
}
