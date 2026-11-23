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
import {
  RefreshLeaseTimeoutError,
  YnabTokenResolver,
  YnabTokenUnavailableError,
  type RefreshLeaseOptions,
} from '../../../src/auth/user-session.js';
import { OutboundTimeoutError, YnabAuthError, YnabAuthUnavailableError } from '../../../src/utils/errors.js';
import type { Storage } from '../../../src/storage/types.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';
import { YnabOAuthError } from '../../../src/auth/ynab-oauth.js';
import { cleanupDrivers, testDrivers } from '../helpers/storage-drivers.js';
import { YnabClient, type AccessTokenSource } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';

/** A YnabClient as OAuth mode builds one: the resolver's token, and a 401 dropping it (#48). */
function oauthClient(token: AccessTokenSource, resolver: YnabTokenResolver, userId = 'u1'): YnabClient {
  return new YnabClient(token, 'budget-1', new RateLimiter(180), new Cache(300000), false, new AuditLog(), undefined, undefined, {
    onUnauthorized: (rejected) => resolver.invalidate(userId, rejected),
  });
}

const ynabUser = (): Response =>
  new Response(JSON.stringify({ data: { user: { id: 'u1' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const ynab401 = (): Response =>
  new Response(JSON.stringify({ error: { id: '401', name: 'unauthorized', detail: 'Unauthorized' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

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

      const before = (await h.storage.getUser('u1'))?.encryptedRefreshToken;
      const timedOut = await resolver.resolve('u1').catch((e: unknown) => e);
      expect(timedOut).toBeInstanceOf(RefreshLeaseTimeoutError);
      // Transient (Q1): retry once the crashed holder's lease has run out.
      expect(timedOut).toBeInstanceOf(YnabTokenUnavailableError);
      expect((timedOut as YnabTokenUnavailableError).retryAfterSeconds).toBe(45);
      const mapped = await resolver.accessTokenFor('u1')().catch((e: unknown) => e);
      expect(mapped).toBeInstanceOf(YnabAuthUnavailableError);
      expect((mapped as YnabAuthUnavailableError).retryAfterSeconds).toBe(45);
      expect(refreshMock).not.toHaveBeenCalled();
      expect((await h.storage.getUser('u1'))?.encryptedRefreshToken).toBe(before);
      // The message names no token.
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('rt0');

      // A timeout is not remembered as a failure: once the lease has expired, the next request refreshes.
      now += 45_001;
      await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-new' });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('a YNAB refresh timeout is transient: the token is kept and not remembered; a following invalid_grant needs a reconnect', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      refreshMock
        .mockRejectedValueOnce(new OutboundTimeoutError(false))
        .mockRejectedValueOnce(new YnabOAuthError('YNAB token request failed with status 400: invalid_grant', 400, 'invalid_grant'));
      const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const before = (await h.storage.getUser('u1'))?.encryptedRefreshToken;

      const timedOut = await a.accessTokenFor('u1')().catch((e: unknown) => e);
      expect(timedOut).toBeInstanceOf(YnabAuthUnavailableError);
      expect((timedOut as YnabAuthUnavailableError).retryAfterSeconds).toBe(5);
      const row = await other.getUser('u1');
      expect(row?.encryptedRefreshToken).toBe(before);
      expect(row?.refreshLeaseUntil).toBeUndefined();

      // Not remembered: the same replica tries again at once, and YNAB says the token is dead.
      const dead = await a.accessTokenFor('u1')().catch((e: unknown) => e);
      expect(dead).toBeInstanceOf(YnabAuthError);
      expect(dead).not.toBeInstanceOf(YnabAuthUnavailableError);
      expect(refreshMock).toHaveBeenCalledTimes(2);
      // That one is remembered on the replica that saw it.
      await expect(a.resolve('u1')).rejects.toThrow(/failed recently/);
      expect(refreshMock).toHaveBeenCalledTimes(2);
      // The lease is free for the other replica.
      expect((await other.getUser('u1'))?.refreshLeaseUntil).toBeUndefined();
    });

    it('a YNAB 5xx is transient and not remembered: the next attempt refreshes at once', async () => {
      const h = await driver.open();
      await seed(h.storage);
      refreshMock
        .mockRejectedValueOnce(new YnabOAuthError('YNAB token request failed with status 503', 503, undefined))
        .mockResolvedValueOnce({ accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR });
      const resolver = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
      const before = (await h.storage.getUser('u1'))?.encryptedRefreshToken;

      await expect(resolver.resolve('u1')).rejects.toBeInstanceOf(YnabTokenUnavailableError);
      expect((await h.storage.getUser('u1'))?.encryptedRefreshToken).toBe(before);
      await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-new' });
      expect(refreshMock).toHaveBeenCalledTimes(2);
      expect(refreshMock).toHaveBeenLastCalledWith(YNAB, 'rt0');
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
        .mockRejectedValueOnce(new YnabOAuthError('YNAB token request failed with status 400: invalid_grant', 400, 'invalid_grant'));
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

    it('a holder whose YNAB call fails after its lease ran out uses the token another replica stored meanwhile', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      let now = Date.now();
      const gate = deferred<void>();
      refreshMock
        .mockImplementationOnce(async () => {
          await gate.promise;
          throw new YnabOAuthError('YNAB token request failed with status 400: invalid_grant', 400, 'invalid_grant');
        })
        .mockResolvedValueOnce({ accessToken: 'access-b', refreshToken: 'rt-b', expiresAt: now + 2 * HOUR });
      const a = new YnabTokenResolver(h.storage, encryptor, YNAB, () => now, { ...fast, leaseTtlMs: 1_000 });
      const b = new YnabTokenResolver(other, encryptor, YNAB, () => now, fast);

      const slow = a.resolve('u1');
      await calls(1);
      now += 1_001;
      await expect(b.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-b' });
      gate.resolve();
      await expect(slow).resolves.toMatchObject({ accessToken: 'access-b' });
      expect(refreshMock).toHaveBeenCalledTimes(2);
      // Not remembered as a failure, and the lease is free.
      expect((await h.storage.getUser('u1'))?.refreshLeaseUntil).toBeUndefined();
    });

    it('a token YNAB rejects is invalidated on every replica: exactly one refresh follows, and no replica reuses it', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      const gate = deferred<void>();
      refreshMock
        .mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: 'rt-1', expiresAt: Date.now() + 2 * HOUR })
        .mockImplementationOnce(async () => {
          await gate.promise;
          return { accessToken: 'access-2', refreshToken: 'rt-2', expiresAt: Date.now() + 2 * HOUR };
        });
      const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
      const b = new YnabTokenResolver(other, encryptor, YNAB, Date.now, fast);
      expect((await a.resolve('u1')).accessToken).toBe('access-1');
      expect((await b.resolve('u1')).accessToken).toBe('access-1'); // the shared token, now cached by b too
      expect(refreshMock).toHaveBeenCalledTimes(1);

      // YNAB answers 401 to access-1 (revoked early): b invalidates it.
      await b.invalidate('u1', 'access-1');
      expect((await h.storage.getUser('u1'))?.encryptedAccessToken).toBeUndefined();

      // Both replicas, a included (it still has access-1 in its own cache), refresh once between them.
      const both = Promise.all([a.resolve('u1'), b.resolve('u1')]);
      await calls(2);
      gate.resolve();
      const [ra, rb] = await both;
      expect(ra.accessToken).toBe('access-2');
      expect(rb.accessToken).toBe('access-2');
      expect(refreshMock).toHaveBeenCalledTimes(2);
      expect(refreshMock).toHaveBeenLastCalledWith(YNAB, 'rt-1');
      expect((await a.resolve('u1')).accessToken).toBe('access-2');
      expect((await b.resolve('u1')).accessToken).toBe('access-2');
    });

    it('invalidating a rejected token keeps a newer one another replica stored meanwhile', async () => {
      const h = await driver.open();
      const other = await h.reopen();
      await seed(h.storage);
      refreshMock
        .mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: 'rt-1', expiresAt: Date.now() + 2 * HOUR })
        .mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: 'rt-2', expiresAt: Date.now() + 2 * HOUR });
      const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
      const b = new YnabTokenResolver(other, encryptor, YNAB, Date.now, fast);
      await a.resolve('u1');
      await a.invalidate('u1', 'access-1');
      expect((await a.resolve('u1')).accessToken).toBe('access-2');

      // b learns late that access-1 was rejected: access-2 stays.
      await b.invalidate('u1', 'access-1');
      const row = await other.getUser('u1');
      expect(encryptor.decrypt(row?.encryptedAccessToken ?? '', accessTokenContext('u1'))).toBe('access-2');
      expect((await b.resolve('u1')).accessToken).toBe('access-2');
      expect(refreshMock).toHaveBeenCalledTimes(2);
    });

    describe('a 401 from the YNAB API (#48)', () => {
      const fetchMock = vi.fn<typeof fetch>();
      beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
      });
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('a tool call that gets a 401 drops the shared token; the next call makes exactly one refresh, on any replica', async () => {
        const h = await driver.open();
        const other = await h.reopen();
        await seed(h.storage);
        refreshMock
          .mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: 'rt-1', expiresAt: Date.now() + 2 * HOUR })
          .mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: 'rt-2', expiresAt: Date.now() + 2 * HOUR });
        const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
        const b = new YnabTokenResolver(other, encryptor, YNAB, Date.now, fast);
        await a.resolve('u1');
        await b.resolve('u1'); // b holds access-1 too, from the row
        fetchMock.mockResolvedValueOnce(ynab401()).mockImplementation(async () => ynabUser());

        await expect(oauthClient(a.accessTokenFor('u1'), a).getUser()).rejects.toBeInstanceOf(YnabAuthError);
        expect(fetchMock).toHaveBeenCalledTimes(1); // not retried
        expect((await other.getUser('u1'))?.encryptedAccessToken).toBeUndefined();

        await oauthClient(b.accessTokenFor('u1'), b).getUser();
        await oauthClient(a.accessTokenFor('u1'), a).getUser();
        expect(refreshMock).toHaveBeenCalledTimes(2);
        expect(refreshMock).toHaveBeenLastCalledWith(YNAB, 'rt-1');
        const sent = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
        expect(sent).toEqual(['Bearer access-1', 'Bearer access-2', 'Bearer access-2']);
      });

      it('a write that gets a 401 is not retried', async () => {
        const h = await driver.open();
        await seed(h.storage);
        refreshMock.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'rt-1', expiresAt: Date.now() + 2 * HOUR });
        const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
        fetchMock.mockImplementation(async () => ynab401());

        const error = await oauthClient(a.accessTokenFor('u1'), a)
          .createTransaction('budget-1', { transaction: { account_id: 'acct-1', date: '2026-11-01', amount: -1000 } })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(YnabAuthError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(refreshMock).toHaveBeenCalledTimes(1);
      });

      it('a 401 on a token another replica has already replaced keeps the newer token', async () => {
        const h = await driver.open();
        const other = await h.reopen();
        await seed(h.storage);
        refreshMock
          .mockResolvedValueOnce({ accessToken: 'access-1', refreshToken: 'rt-1', expiresAt: Date.now() + 2 * HOUR })
          .mockResolvedValueOnce({ accessToken: 'access-2', refreshToken: 'rt-2', expiresAt: Date.now() + 2 * HOUR });
        const a = new YnabTokenResolver(h.storage, encryptor, YNAB, Date.now, fast);
        const b = new YnabTokenResolver(other, encryptor, YNAB, Date.now, fast);
        await a.resolve('u1');
        await a.invalidate('u1', 'access-1');
        await a.resolve('u1'); // the row now holds access-2

        // b's call went out with access-1 before that, and comes back 401.
        fetchMock.mockResolvedValueOnce(ynab401()).mockImplementation(async () => ynabUser());
        await expect(oauthClient(async () => 'access-1', b).getUser()).rejects.toBeInstanceOf(YnabAuthError);
        const row = await other.getUser('u1');
        expect(encryptor.decrypt(row?.encryptedAccessToken ?? '', accessTokenContext('u1'))).toBe('access-2');
        await oauthClient(b.accessTokenFor('u1'), b).getUser();
        expect(refreshMock).toHaveBeenCalledTimes(2);
      });
    });

    describe('a replica below the key floor (#57b write-path rule)', () => {
      const k1 = randomBytes(32).toString('base64');
      const onKey1 = new Encryptor(k1);
      const onKey2 = new Encryptor(randomBytes(32).toString('base64'), { keyId: '2', previousKeys: `1:${k1}` });

      async function seedUnder(storage: Storage, enc: Encryptor, token = 'rt0'): Promise<void> {
        await storage.upsertUser({
          userId: 'u1',
          grantedScope: 'read-write',
          encryptedRefreshToken: enc.encrypt(token, refreshTokenContext('u1')),
          updatedAt: Date.now(),
        });
      }

      it('holding the lease, it is refused before YNAB, frees the lease, and no token is lost', async () => {
        const h = await driver.open();
        const other = await h.reopen();
        await seedUnder(h.storage, onKey1);
        const stored = (await h.storage.getUser('u1'))?.encryptedRefreshToken;
        await other.announceKeyRetirement(2); // a replica on key 2 announced it
        refreshMock.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR });
        const old = new YnabTokenResolver(h.storage, onKey1, YNAB, Date.now, fast);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // An operator problem, not the user's token: transient (503 at /mcp), not a reconnect.
        const refused = await old.accessTokenFor('u1')().catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(YnabAuthUnavailableError);
        expect((refused as YnabAuthUnavailableError).retryAfterSeconds).toBe(30);
        await expect(old.resolve('u1')).rejects.toBeInstanceOf(YnabTokenUnavailableError);
        // Not remembered as failed: each attempt checks the floors again.
        await expect(old.resolve('u1')).rejects.not.toThrow(/failed recently/);
        expect(refreshMock).not.toHaveBeenCalled();
        const row = await other.getUser('u1');
        expect(row?.encryptedRefreshToken).toBe(stored);
        expect(row?.refreshLeaseUntil).toBeUndefined();
        expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/Refusing to write with ENCRYPTION_KEY_ID 1/);

        // The token is intact: a replica on the new key refreshes from it.
        const current = new YnabTokenResolver(other, onKey2, YNAB, Date.now, fast);
        await expect(current.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-new' });
        expect(refreshMock).toHaveBeenCalledExactlyOnceWith(YNAB, 'rt0');
      });

      it('a write-back the storage guard refuses (a retirement announced during the YNAB call) takes the same 503 path', async () => {
        const h = await driver.open();
        const other = await h.reopen();
        await seedUnder(h.storage, onKey1);
        const stored = (await h.storage.getUser('u1'))?.encryptedRefreshToken;
        const gate = deferred<void>();
        refreshMock.mockImplementationOnce(async () => {
          await gate.promise;
          return { accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR };
        });
        const old = new YnabTokenResolver(h.storage, onKey1, YNAB, Date.now, fast);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // assertKeyWritable passes (nothing announced yet); the call is in flight.
        const inFlight = old.resolve('u1').catch((e: unknown) => e);
        await calls(1);
        expect((await other.getUser('u1'))?.refreshLeaseUntil).toBeDefined();
        await other.announceKeyRetirement(2);
        gate.resolve();

        const refused = await inFlight;
        expect(refused).toBeInstanceOf(YnabTokenUnavailableError);
        expect((refused as YnabTokenUnavailableError).retryAfterSeconds).toBe(30);
        const row = await other.getUser('u1');
        expect(row?.encryptedRefreshToken).toBe(stored);
        expect(row?.encryptedAccessToken).toBeUndefined();
        expect(row?.refreshLeaseUntil).toBeUndefined();
        expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/Refusing to write with ENCRYPTION_KEY_ID 1/);
        // Not remembered as failed: the next attempt is refused by the write-path check, before YNAB.
        const again = await old.accessTokenFor('u1')().catch((e: unknown) => e);
        expect(again).toBeInstanceOf(YnabAuthUnavailableError);
        expect(refreshMock).toHaveBeenCalledTimes(1);
      });

      it('a shared access token left under the retired key neither holds the retirement back nor is read after it', async () => {
        const h = await driver.open();
        const keyring = new Encryptor(randomBytes(32).toString('base64'), { keyId: '2', previousKeys: `1:${k1}` });
        await seedUnder(h.storage, keyring);
        // Written just before the announcement by a replica still on key 1.
        const row = await h.storage.getUser('u1');
        await h.storage.updateUserRefreshToken('u1', row?.encryptedRefreshToken ?? '', row?.encryptedRefreshToken ?? '', {
          encryptedAccessToken: onKey1.encrypt('access-old-key', accessTokenContext('u1')),
          expiresAt: Date.now() + 2 * HOUR,
          now: Date.now(),
        });
        await h.storage.announceKeyRetirement(2);
        expect(await h.storage.raiseRetiredKeyFloor(2)).toBe(2);
        keyring.retireBelow(await h.storage.getRetiredKeyFloor());

        refreshMock.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'rt-rotated', expiresAt: Date.now() + 2 * HOUR });
        const resolver = new YnabTokenResolver(h.storage, keyring, YNAB, Date.now, fast);
        await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-new' });
        expect(refreshMock).toHaveBeenCalledExactlyOnceWith(YNAB, 'rt0');
      });

      it('re-checks on the retry after a compare-and-set miss: no second YNAB call once the retirement is announced', async () => {
        const h = await driver.open();
        const other = await h.reopen();
        await seedUnder(h.storage, onKey1);
        const gate = deferred<void>();
        refreshMock.mockImplementationOnce(async () => {
          await gate.promise;
          return { accessToken: 'access-old-grant', refreshToken: 'rt-old-rotated', expiresAt: Date.now() + 2 * HOUR };
        });
        const old = new YnabTokenResolver(h.storage, onKey1, YNAB, Date.now, fast);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const inFlight = old.resolve('u1');
        await calls(1);
        // Meanwhile: a re-consent on the new key, and the retirement is announced.
        await seedUnder(other, onKey2, 'rt-new-grant');
        const reconsented = (await other.getUser('u1'))?.encryptedRefreshToken;
        await other.announceKeyRetirement(2);
        gate.resolve();

        await expect(inFlight).rejects.toThrow(/Refusing to write with ENCRYPTION_KEY_ID 1/);
        expect(refreshMock).toHaveBeenCalledTimes(1);
        const row = await other.getUser('u1');
        expect(row?.encryptedRefreshToken).toBe(reconsented);
        expect(row?.refreshLeaseUntil).toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
      });
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
