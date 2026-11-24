/**
 * #64b on every driver: which YNAB token a completed sign-in leaves on the
 * user's row (saveAuthorizationCode, #94's atomic sign-in). The D-9 result:
 * a second, read-only YNAB authorization doesn't invalidate the first,
 * read-write one, so
 *
 *   - read-write, then read-only from another client: the read-write token is
 *     kept and the read-only one discarded;
 *   - read-only, then read-write: the token is upgraded;
 *   - a read-write grant revoked (or with nothing live left), then read-only:
 *     the read-only token is stored;
 *   - a read-write client in the middle of its code exchange (its code
 *     consumed, its tokens not yet saved) still counts as live;
 *   - concurrent sign-ins, on two connections: read-write wins in either order.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { GrantedScope, OAuthRowStore, OAuthRowWrite, Storage } from '../../../src/storage/types.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import { cleanupDrivers, testDrivers } from '../helpers/storage-drivers.js';

type Store = Storage & OAuthRowStore;

const RESOURCE = 'https://mcp.example.com/mcp';
const blank = { payload: '{}', grantId: undefined, accountId: undefined, clientId: undefined, uid: undefined, expiresAt: undefined };

/** A grant payload as the library writes one for the consent choice (D7). */
function grantPayload(scope: GrantedScope, accountId: string, clientId: string): string {
  return JSON.stringify(
    scope === 'read-write'
      ? { accountId, clientId, resources: { [RESOURCE]: 'read-only read-write' } }
      : { accountId, clientId, resources: { [RESOURCE]: 'read-only' }, rejected: { resources: { [RESOURCE]: 'read-write' } } }
  );
}

interface SignIn {
  grantId: string;
  code: OAuthRowWrite;
}

/** A client, a grant of `scope` for `userId`, and a sign-in staged with YNAB token `token`; returns its code row. */
async function staged(store: Store, userId: string, scope: GrantedScope, token: string): Promise<SignIn> {
  const clientId = `c-${randomUUID()}`;
  const grantId = `g-${randomUUID()}`;
  await store.upsertOAuthRow({ ...blank, key: plainRowKey('Client', clientId), model: 'Client', clientId });
  await store.upsertOAuthRow({
    ...blank,
    key: plainRowKey('Grant', grantId),
    model: 'Grant',
    payload: grantPayload(scope, userId, clientId),
    grantId,
    accountId: userId,
    clientId,
    expiresAt: Date.now() + 3_600_000,
  });
  expect(
    await store.stageSignIn({
      grantId,
      user: { userId, grantedScope: scope, encryptedRefreshToken: token, updatedAt: Date.now() },
      expiresAt: Date.now() + 60_000,
    })
  ).toBe(true);
  return {
    grantId,
    code: {
      ...blank,
      key: `h1.${randomUUID()}`,
      model: 'AuthorizationCode',
      grantId,
      accountId: userId,
      clientId,
      expiresAt: Date.now() + 600_000,
    },
  };
}

async function complete(store: Store, userId: string, scope: GrantedScope, token: string): Promise<SignIn> {
  const signIn = await staged(store, userId, scope, token);
  expect(await store.saveAuthorizationCode(signIn.code)).toBe('saved');
  return signIn;
}

async function stored(store: Store, userId: string) {
  const user = await store.getUser(userId);
  return { token: user?.encryptedRefreshToken, scope: user?.grantedScope };
}

afterEach(async () => {
  await cleanupDrivers();
});

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`#64b: the YNAB token a sign-in leaves (${driver.name})`, () => {
    it('read-write, then read-only from another client: the read-write token is kept', async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-write', 'enc-rw');
      const ro = await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-rw', scope: 'read-write' });
      // The discarded token isn't left behind in the staged sign-in either.
      expect(await store.findOAuthRow(plainRowKey('SignIn', ro.grantId))).toBeUndefined();
    });

    it('read-only, then read-write: the token is upgraded', async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-only', 'enc-ro');
      await complete(store, 'u1', 'read-write', 'enc-rw');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-rw', scope: 'read-write' });
    });

    it('read-only, then read-only: the newer token replaces the older', async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-only', 'enc-ro-1');
      await complete(store, 'u1', 'read-only', 'enc-ro-2');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro-2', scope: 'read-only' });
    });

    it('read-write, then read-write: the newer token replaces the older', async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-write', 'enc-rw-1');
      await complete(store, 'u1', 'read-write', 'enc-rw-2');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-rw-2', scope: 'read-write' });
    });

    it('a read-write grant revoked, then read-only: the read-only token is stored', async () => {
      const store = (await driver.open()).storage as Store;
      const rw = await complete(store, 'u1', 'read-write', 'enc-rw');
      await store.revokeOAuthGrant(rw.grantId);
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro', scope: 'read-only' });
    });

    it('a read-write grant with nothing live left, then read-only: the read-only token is stored', async () => {
      const store = (await driver.open()).storage as Store;
      const rw = await staged(store, 'u1', 'read-write', 'enc-rw');
      // Its only credential has expired.
      expect(await store.saveAuthorizationCode({ ...rw.code, expiresAt: Date.now() - 1_000 })).toBe('saved');
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro', scope: 'read-only' });
    });

    it('a read-write client in the middle of its code exchange still counts as live', async () => {
      const store = (await driver.open()).storage as Store;
      const rw = await complete(store, 'u1', 'read-write', 'enc-rw');
      // The library consumed the code; its tokens aren't saved yet.
      expect(await store.consumeOAuthRow(rw.code.key)).toBe('consumed');
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-rw', scope: 'read-write' });
    });

    it("another user's read-write grant doesn't keep this user's token", async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u2', 'read-write', 'enc-rw-u2');
      await complete(store, 'u1', 'read-only', 'enc-ro-u1');
      await complete(store, 'u1', 'read-only', 'enc-ro-u1-b');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro-u1-b', scope: 'read-only' });
      expect(await stored(store, 'u2')).toEqual({ token: 'enc-rw-u2', scope: 'read-write' });
    });

    it('concurrent read-write and read-only sign-ins, on two connections: read-write wins either way', async () => {
      const h = await driver.open();
      const a = h.storage as Store;
      const b = (await h.reopen()) as Store;
      for (let i = 0; i < 6; i++) {
        const user = `u-${i}`;
        const rw = await staged(a, user, 'read-write', `enc-rw-${i}`);
        const ro = await staged(a, user, 'read-only', `enc-ro-${i}`);
        const order = i % 2 === 0 ? [a.saveAuthorizationCode(rw.code), b.saveAuthorizationCode(ro.code)] : [b.saveAuthorizationCode(ro.code), a.saveAuthorizationCode(rw.code)];
        expect(await Promise.all(order)).toEqual(['saved', 'saved']);
        expect(await stored(a, user)).toEqual({ token: `enc-rw-${i}`, scope: 'read-write' });
      }
    });
  });
}
