/**
 * Unit tests for `YnabTokenResolver`: caching, refresh-token rotation persistence,
 * unknown-user handling, and cache invalidation. Only refreshAccessToken (the YNAB
 * network call) is mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>(
      '../../../src/auth/ynab-oauth.js'
    );
  return { ...actual, refreshAccessToken: vi.fn() };
});

import { MemoryStorage } from '../../../src/storage/memory.js';
import { Encryptor, refreshTokenContext } from '../../../src/crypto.js';
import { YnabTokenResolver } from '../../../src/auth/user-session.js';
import { rekeyPass } from '../../../src/auth/rekey-job.js';
import { YnabAuthError } from '../../../src/utils/errors.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';

const refreshAccessTokenMock = vi.mocked(ynabOauth.refreshAccessToken);

function setup(now: () => number = Date.now): {
  storage: MemoryStorage;
  encryptor: Encryptor;
  resolver: YnabTokenResolver;
} {
  const storage = new MemoryStorage();
  const encryptor = new Encryptor(randomBytes(32).toString('base64'));
  const resolver = new YnabTokenResolver(
    storage,
    encryptor,
    { clientId: 'cid', clientSecret: 'sec' },
    now
  );
  return { storage, encryptor, resolver };
}

async function seedUser(storage: MemoryStorage, encryptor: Encryptor): Promise<void> {
  await storage.upsertUser({
    userId: 'u1',
    grantedScope: 'read-only',
    encryptedRefreshToken: encryptor.encrypt('rt0', refreshTokenContext('u1')),
    updatedAt: Date.now(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshAccessTokenMock.mockResolvedValue({
    accessToken: 'access-fresh',
    refreshToken: 'rt-rotated',
    expiresAt: Date.now() + 3600_000,
  });
});

describe('YnabTokenResolver.resolve', () => {
  it('refreshes once and returns the access token and granted scope', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    const resolved = await resolver.resolve('u1');
    expect(resolved.accessToken).toBe('access-fresh');
    expect(resolved.grantedScope).toBe('read-only');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    // Refresh was called with the DECRYPTED seed refresh token.
    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      { clientId: 'cid', clientSecret: 'sec' },
      'rt0'
    );
  });

  it('uses the cache on a second immediate resolve (no second refresh)', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    await resolver.resolve('u1');
    const again = await resolver.resolve('u1');
    expect(again.accessToken).toBe('access-fresh');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it('persists the rotated refresh token (encrypted) on refresh', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    await resolver.resolve('u1');
    const user = await storage.getUser('u1');
    expect(user).toBeDefined();
    // Stored value is not the plaintext, and decrypts to the rotated token.
    expect(user?.encryptedRefreshToken).not.toBe('rt-rotated');
    expect(encryptor.decrypt(user?.encryptedRefreshToken ?? '', refreshTokenContext('u1'))).toBe('rt-rotated');
  });

  it('throws for an unknown user', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve('nobody')).rejects.toThrow(/Unknown user/);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });
});

describe('YnabTokenResolver concurrent refresh', () => {
  it('runs one refresh for concurrent resolves (the refresh token rotates)', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    const results = await Promise.all([resolver.resolve('u1'), resolver.resolve('u1'), resolver.resolve('u1')]);
    expect(results.map((r) => r.accessToken)).toEqual(['access-fresh', 'access-fresh', 'access-fresh']);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it('remembers a failed refresh briefly, then tries again', async () => {
    let now = Date.now();
    const { storage, encryptor, resolver } = setup(() => now);
    await seedUser(storage, encryptor);
    refreshAccessTokenMock.mockRejectedValueOnce(new Error('YNAB token request failed with status 400'));

    await expect(resolver.resolve('u1')).rejects.toThrow('status 400');
    // Within the window: refused without another token-endpoint call.
    await expect(resolver.resolve('u1')).rejects.toThrow(/failed recently/);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

    now += 30_001;
    await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-fresh' });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it('tries a newly stored grant at once, despite a remembered failure', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);
    refreshAccessTokenMock.mockRejectedValueOnce(new Error('YNAB token request failed with status 400'));
    await expect(resolver.resolve('u1')).rejects.toThrow('status 400');

    // The user re-authorizes: a new refresh token is stored.
    await storage.upsertUser({
      userId: 'u1',
      grantedScope: 'read-only',
      encryptedRefreshToken: encryptor.encrypt('rt-new-grant', refreshTokenContext('u1')),
      updatedAt: Date.now(),
    });
    await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-fresh' });
    expect(refreshAccessTokenMock).toHaveBeenLastCalledWith({ clientId: 'cid', clientSecret: 'sec' }, 'rt-new-grant');
  });

  it('forgets a remembered failure on invalidate()', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);
    refreshAccessTokenMock.mockRejectedValueOnce(new Error('YNAB token request failed with status 503'));
    await expect(resolver.resolve('u1')).rejects.toThrow('status 503');

    await resolver.invalidate('u1');
    await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-fresh' });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
  });
});

describe('YnabTokenResolver.accessTokenFor', () => {
  it("resolves the user's current token on every call", async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);
    const getToken = resolver.accessTokenFor('u1');

    await expect(getToken()).resolves.toBe('access-fresh');
    await resolver.invalidate('u1', 'access-fresh');
    refreshAccessTokenMock.mockResolvedValueOnce({
      accessToken: 'access-next',
      refreshToken: 'rt-next',
      expiresAt: Date.now() + 3600_000,
    });
    await expect(getToken()).resolves.toBe('access-next');
  });

  it('fails with a generic YnabAuthError once the grant is gone, logging only a sanitized cause', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);
    const getToken = resolver.accessTokenFor('u1');
    await getToken();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Still cached, but the user record is gone: refused without a refresh.
    await storage.deleteUser('u1');
    const err = await getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YnabAuthError);
    expect((err as Error).message).toBe('YNAB authorization unavailable');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('[YnabToken]');
    errorSpy.mockRestore();
  });

  it('maps a failed refresh to the same generic error', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);
    refreshAccessTokenMock.mockRejectedValueOnce(new Error('YNAB token request failed with status 401'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await resolver.accessTokenFor('u1')().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YnabAuthError);
    expect((err as Error).message).not.toContain('401');
    errorSpy.mockRestore();
  });

  it('logs a failed refresh once, not again for each call refused while it is remembered', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);
    refreshAccessTokenMock.mockRejectedValueOnce(new Error('YNAB token request failed with status 401'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getToken = resolver.accessTokenFor('u1');

    for (let i = 0; i < 3; i++) {
      await expect(getToken()).rejects.toBeInstanceOf(YnabAuthError);
    }
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('YnabTokenResolver.invalidate', () => {
  it('forces a refresh on the next resolve after invalidation', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    await resolver.resolve('u1');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

    // YNAB rejected the token: dropped here and in the row (#48).
    await resolver.invalidate('u1', 'access-fresh');
    expect((await storage.getUser('u1'))?.encryptedAccessToken).toBeUndefined();

    await resolver.resolve('u1');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    // The second refresh used the rotated token persisted by the first.
    expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
      { clientId: 'cid', clientSecret: 'sec' },
      'rt-rotated'
    );
  });

  it('without the rejected token, drops only this process\'s state: the shared token is still used (#48)', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    await resolver.resolve('u1');
    await resolver.invalidate('u1');
    await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-fresh' });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes from the rotated token once the shared access token nears expiry', async () => {
    let now = Date.now();
    const { storage, encryptor, resolver } = setup(() => now);
    await seedUser(storage, encryptor);

    await resolver.resolve('u1');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

    now += 3600_000 - 30_000; // inside the minute before expiry

    await resolver.resolve('u1');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    // The second refresh used the rotated token persisted by the first.
    expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
      { clientId: 'cid', clientSecret: 'sec' },
      'rt-rotated'
    );
  });
});

describe('YnabTokenResolver and the rekey job (#57b)', () => {
  it('a rekey during a refresh does not make the resolver refresh again from the spent token', async () => {
    const storage = new MemoryStorage();
    const k1 = randomBytes(32).toString('base64');
    const before = new Encryptor(k1);
    await storage.upsertUser({
      userId: 'u1',
      grantedScope: 'read-only',
      encryptedRefreshToken: before.encrypt('rt0', refreshTokenContext('u1')),
      updatedAt: Date.now(),
    });
    const keyring = new Encryptor(randomBytes(32).toString('base64'), { keyId: '2', previousKeys: `1:${k1}` });
    const resolver = new YnabTokenResolver(storage, keyring, { clientId: 'cid', clientSecret: 'sec' });

    // The rekey job moves the row to key 2 while YNAB is rotating the token.
    refreshAccessTokenMock.mockImplementationOnce(async () => {
      await rekeyPass(storage, keyring, {}, { log: () => undefined });
      return { accessToken: 'access-fresh', refreshToken: 'rt-rotated', expiresAt: Date.now() + 3600_000 };
    });

    await expect(resolver.resolve('u1')).resolves.toMatchObject({ accessToken: 'access-fresh' });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    const user = await storage.getUser('u1');
    expect(user?.encryptedRefreshToken.startsWith('v2.2.')).toBe(true);
    expect(keyring.decrypt(user?.encryptedRefreshToken ?? '', refreshTokenContext('u1'))).toBe('rt-rotated');
  });

  it("refuses another user's ciphertext copied into the row, before calling YNAB", async () => {
    const { storage, encryptor, resolver } = setup();
    await storage.upsertUser({
      userId: 'u1',
      grantedScope: 'read-only',
      encryptedRefreshToken: encryptor.encrypt('rt-of-u2', refreshTokenContext('u2')),
      updatedAt: Date.now(),
    });
    await expect(resolver.resolve('u1')).rejects.toThrow();
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });
});
