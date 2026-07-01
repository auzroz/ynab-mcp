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
import { Encryptor } from '../../../src/crypto.js';
import { YnabTokenResolver } from '../../../src/auth/user-session.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';

const refreshAccessTokenMock = vi.mocked(ynabOauth.refreshAccessToken);

function setup(): {
  storage: MemoryStorage;
  encryptor: Encryptor;
  resolver: YnabTokenResolver;
} {
  const storage = new MemoryStorage();
  const encryptor = new Encryptor(randomBytes(32).toString('base64'));
  const resolver = new YnabTokenResolver(storage, encryptor, {
    clientId: 'cid',
    clientSecret: 'sec',
  });
  return { storage, encryptor, resolver };
}

async function seedUser(storage: MemoryStorage, encryptor: Encryptor): Promise<void> {
  await storage.upsertUser({
    userId: 'u1',
    grantedScope: 'read-only',
    encryptedRefreshToken: encryptor.encrypt('rt0'),
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
    expect(encryptor.decrypt(user?.encryptedRefreshToken ?? '')).toBe('rt-rotated');
  });

  it('throws for an unknown user', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve('nobody')).rejects.toThrow(/Unknown user/);
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });
});

describe('YnabTokenResolver.invalidate', () => {
  it('forces a refresh on the next resolve after invalidation', async () => {
    const { storage, encryptor, resolver } = setup();
    await seedUser(storage, encryptor);

    await resolver.resolve('u1');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

    resolver.invalidate('u1');

    await resolver.resolve('u1');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    // The second refresh used the rotated token persisted by the first.
    expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
      { clientId: 'cid', clientSecret: 'sec' },
      'rt-rotated'
    );
  });
});
