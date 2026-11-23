/**
 * #48: YNAB refresh-token rotation across replicas, on every storage driver.
 * Each "replica" is its own YnabTokenResolver over its own storage handle on
 * one database (`reopen()`: a second connection on SQLite, a second pool on
 * Postgres; the same instance for memory). Only the YNAB token call is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>(
    '../../../src/auth/ynab-oauth.js'
  );
  return { ...actual, refreshAccessToken: vi.fn() };
});

import { Encryptor, accessTokenContext, refreshTokenContext } from '../../../src/crypto.js';
import { RefreshLeaseTimeoutError, YnabTokenResolver, type RefreshLeaseOptions } from '../../../src/auth/user-session.js';
import { YnabAuthError } from '../../../src/utils/errors.js';
import type { Storage } from '../../../src/storage/types.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';
import { cleanupDrivers, testDrivers } from '../helpers/storage-drivers.js';

const refreshMock = vi.mocked(ynabOauth.refreshAccessToken);
const YNAB = { clientId: 'cid', clientSecret: 'sec' };
const HOUR = 3_600_000;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolves once the mock has been called `n` times. */
async function calls(n: number): Promise<void> {
  for (let i = 0; i < 400 && refreshMock.mock.calls.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  expect(refreshMock).toHaveBeenCalledTimes(n);
}

const fast: RefreshLeaseOptions = { pollFirstMs: 5, pollMaxMs: 20 };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`refresh lease across replicas (#48): ${driver.name}`, () => {
    const encryptor = new Encryptor(randomBytes(32).toString('base64'));

    async function seed(storage: Storage, userId = 'u1', token = 'rt0'): Promise<void> {
      await storage.upsertUser({
        userId,
        grantedScope: 'read-write',
        encryptedRefreshToken: encryptor.encrypt(token, refreshTokenContext(userId)),
        updatedAt: Date.now(),
      });
    }

    it('two replicas refreshing at once make exactly one YNAB call, and both get the new access token', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      const gate = deferred<void>();
      refreshMock.mockImplementation(async () => {
        await gate.promise;
        return { accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR };
      });
      const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
      const b = new YnabTokenResolver(other, encryptor, YNAB, Date.now, fast);

      const both = Promise.all([a.resolve('u1'), b.resolve('u1')]);
      await calls(1);
      // The loser is polling, not calling YNAB, while the winner's call is in flight.
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshMock).toHaveBeenCalledTimes(1);
      gate.resolve();

      const [ra, rb] = await both;
      expect(ra.accessToken).toBe('access-new');
      expect(rb.accessToken).toBe('access-new');
      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(refreshMock).toHaveBeenCalledWith(YNAB, 'rt0');

      const row = await other.getUser('u1');
      expect(encryptor.decrypt(row?.encryptedRefreshToken ?? '', refreshTokenContext('u1'))).toBe('rt-rotated');
      // The shared token is bound to its own column: the refresh token's context does not open it.
      expect(encryptor.decrypt(row?.encryptedAccessToken ?? '', accessTokenContext('u1'))).toBe('access-new');
      expect(() => encryptor.decrypt(row?.encryptedAccessToken ?? '', refreshTokenContext('u1'))).toThrow();
      expect(row?.refreshLeaseUntil).toBeUndefined();
    });

    it("a replica that never refreshed uses the other replica's shared token without calling YNAB", async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      refreshMock.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR });

      await new YnabTokenResolver(h.storage, encryptor, YNAB).resolve('u1');
      const later = await new YnabTokenResolver(other, encryptor, YNAB).resolve('u1');
      expect(later).toMatchObject({ accessToken: 'access-new', grantedScope: 'read-write' });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the lease outlasts the wait: no YNAB call, a mapped error, then a refresh once it expires', async () => {
      const h = await driver.open();
      await seed(h.storage);
      let now = Date.now();
      // A holder that crashed mid-refresh.
      expect(await h.storage.claimRefreshLease('u1', 'crashed', now, now + 45_000)).toBeDefined();
      refreshMock.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: now + 2 * HOUR });
      const resolver = new YnabTokenResolver(h.storage, encryptor, YNAB, () => now, { ...fast, leaseWaitMs: 60 });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(resolver.resolve('u1')).rejects.toBeInstanceOf(RefreshLeaseTimeoutError);
      await expect(resolver.accessTokenFor('u1')()).rejects.toBeInstanceOf(YnabAuthError);
      expect(refreshMock).not.toHaveBeenCalled();
      // The message names no token.
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('rt0');

      // A timeout is not remembered as a failure: once the lease has expired, the next request refreshes.
      now += 45_001;
      await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-new' });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('a holder whose lease ran out mid-call still stores its token (the compare-and-set is on the ciphertext)', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      let now = Date.now();
      const gate = deferred<void>();
      refreshMock
        .mockImplementationOnce(async () => {
          await gate.promise;
          return { accessToken: 'access-a', refreshToken: 'rt-a', expiresAt: now + 2 * HOUR };
        })
        // YNAB refuses the second use of the same refresh token.
        .mockRejectedValueOnce(new Error('YNAB token request failed with status 400'));
      const a = new YnabTokenResolver(h.storage, encryptor, YNAB, () => now, { ...fast, leaseTtlMs: 1_000 });
      const b = new YnabTokenResolver(other, encryptor, YNAB, () => now, fast);

      const slow = a.resolve('u1');
      await calls(1);
      now += 1_001; // a's lease has expired: b claims it and fails at YNAB
      await expect(b.resolve('u1')).rejects.toThrow('status 400');
      gate.resolve();
      await expect(slow).resolves.toMatchObject({ accessToken: 'access-a' });

      const row = await h.storage.getUser('u1');
      expect(encryptor.decrypt(row?.encryptedRefreshToken ?? '', refreshTokenContext('u1'))).toBe('rt-a');
      // b's remembered failure is for the spent token; the shared one is fresh, so b uses it.
      await expect(b.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-a' });
      expect(refreshMock).toHaveBeenCalledTimes(2);
    });

    it('a re-consent during a refresh clears the lease and the shared token, and wins', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      const gate = deferred<void>();
      refreshMock
        .mockImplementationOnce(async () => {
          await gate.promise;
          return { accessToken: 'access-old-grant', refreshToken: 'rt-old-rotated', expiresAt: Date.now() + 2 * HOUR };
        })
        .mockResolvedValueOnce({ accessToken: 'access-new-grant', refreshToken: 'rt-new-rotated', expiresAt: Date.now() + 2 * HOUR });
      const resolver = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);

      const inFlight = resolver.resolve('u1');
      await calls(1);
      expect((await other.getUser('u1'))?.refreshLeaseUntil).toBeDefined();
      await seed(other, 'u1', 'rt-new-grant');
      const reconsented = await other.getUser('u1');
      expect(reconsented?.refreshLeaseUntil).toBeUndefined();
      expect(reconsented?.encryptedAccessToken).toBeUndefined();
      gate.resolve();

      await expect(inFlight).resolves.toMatchObject({ accessToken: 'access-new-grant' });
      expect(refreshMock).toHaveBeenLastCalledWith(YNAB, 'rt-new-grant');
      const row = await h.storage.getUser('u1');
      expect(encryptor.decrypt(row?.encryptedRefreshToken ?? '', refreshTokenContext('u1'))).toBe('rt-new-rotated');
    });

    it("refuses a shared token copied from another user's row, and refreshes instead", async () => {
      const h = await driver.open();
      await seed(h.storage, 'u1');
      const row = await h.storage.getUser('u1');
      // u2's access token, encrypted for u2, planted in u1's row.
      await h.storage.updateUserRefreshToken('u1', row?.encryptedRefreshToken ?? '', row?.encryptedRefreshToken ?? '', {
        encryptedAccessToken: encryptor.encrypt('access-of-u2', accessTokenContext('u2')),
        expiresAt: Date.now() + 2 * HOUR,
        now: Date.now(),
      });
      refreshMock.mockResolvedValue({ accessToken: 'access-u1', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR });

      await expect(new YnabTokenResolver(h.storage, encryptor, YNAB).resolve('u1')).resolves.toMatchObject({
        accessToken: 'access-u1',
      });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('of many concurrent claims on two handles, exactly one wins', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      const now = Date.now();
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? other : h.storage).claimRefreshLease('u1', `h${i}`, now, now + 45_000))
      );
      expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
      // Only the holder releases it.
      const winner = claims.findIndex((c) => c !== undefined);
      await h.storage.releaseRefreshLease('u1', `h${(winner + 1) % 12}`);
      expect((await h.storage.getUser('u1'))?.refreshLeaseUntil).toBeDefined();
      await other.releaseRefreshLease('u1', `h${winner}`);
      expect((await h.storage.getUser('u1'))?.refreshLeaseUntil).toBeUndefined();
      // An expired lease can be claimed again.
      expect(await h.storage.claimRefreshLease('u1', 'x', now, now + 10)).toBeDefined();
      expect(await other.claimRefreshLease('u1', 'y', now + 5, now + 50)).toBeUndefined();
      expect(await other.claimRefreshLease('u1', 'y', now + 10, now + 50)).toBeDefined();
    });
  });
}
