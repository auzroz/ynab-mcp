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
 *   - concurrent sign-ins, on two connections: read-write wins in either order;
 *   - a stored read-write token YNAB refused (a YnabTokenRejected marker for
 *     its exact ciphertext), then read-only: the read-only token replaces it,
 *     even while another read-write grant is live; a marker for another
 *     ciphertext changes nothing; a rekey of the token carries its marker.
 *     Erasure and the sweep remove markers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { plainRowKey, rejectedYnabTokenKey, rejectedYnabTokenRow } from '../../../src/storage/oauth-rows.js';
import { cleanupDrivers, testDrivers } from '../helpers/storage-drivers.js';
import { complete, staged, stored, type Store } from '../helpers/sign-in.js';

const DAY = 86_400_000;

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
      // u1 holds a read-write token whose grant is gone; u2's read-write grant is live.
      const rw = await complete(store, 'u1', 'read-write', 'enc-rw-u1');
      await store.revokeOAuthGrant(rw.grantId);
      await complete(store, 'u2', 'read-write', 'enc-rw-u2');
      await complete(store, 'u1', 'read-only', 'enc-ro-u1');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro-u1', scope: 'read-only' });
      expect(await stored(store, 'u2')).toEqual({ token: 'enc-rw-u2', scope: 'read-write' });
    });

    it('a stored read-write token YNAB refused, another read-write grant live, then read-only: the read-only token replaces it', async () => {
      const store = (await driver.open()).storage as Store;
      // The read-write grant stays live; YNAB has refused its token.
      await complete(store, 'u1', 'read-write', 'enc-rw');
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-rw', Date.now() + DAY));
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro', scope: 'read-only' });
    });

    it('a marker for an older ciphertext, or for another user, does not stop the read-write token being kept', async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-write', 'enc-rw-old');
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-rw-old', Date.now() + DAY));
      // A newer read-write sign-in stored another ciphertext: the marker no longer matches.
      await complete(store, 'u1', 'read-write', 'enc-rw');
      // The same ciphertext refused for another user names a different marker.
      await store.upsertOAuthRow(rejectedYnabTokenRow('u2', 'enc-rw', Date.now() + DAY));
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-rw', scope: 'read-write' });
    });

    it('an expired marker that the sweep has not removed yet still counts', async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-write', 'enc-rw');
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-rw', Date.now() - DAY));
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro', scope: 'read-only' });
    });

    it('a rekey of a refused token carries its marker to the new ciphertext; a rekey of a healthy one writes none', async () => {
      const store = (await driver.open()).storage as Store;
      const expiresAt = Date.now() + DAY;
      await complete(store, 'u1', 'read-write', 'enc-rw');
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-rw', expiresAt));
      expect(await store.rekeyUserRefreshToken('u1', 'enc-rw', 'enc-rw-rekeyed')).toBe(true);
      expect(await store.findOAuthRow(rejectedYnabTokenKey('u1', 'enc-rw'))).toBeUndefined();
      const carried = await store.findOAuthRow(rejectedYnabTokenKey('u1', 'enc-rw-rekeyed'));
      expect(carried).toMatchObject({ model: 'YnabTokenRejected', accountId: 'u1', expiresAt });
      await complete(store, 'u1', 'read-only', 'enc-ro');
      expect(await stored(store, 'u1')).toEqual({ token: 'enc-ro', scope: 'read-only' });

      await complete(store, 'u2', 'read-write', 'enc-rw-u2');
      expect(await store.rekeyUserRefreshToken('u2', 'enc-rw-u2', 'enc-rw-u2-rekeyed')).toBe(true);
      expect(await store.findOAuthRow(rejectedYnabTokenKey('u2', 'enc-rw-u2-rekeyed'))).toBeUndefined();
      await complete(store, 'u2', 'read-only', 'enc-ro-u2');
      expect(await stored(store, 'u2')).toEqual({ token: 'enc-rw-u2-rekeyed', scope: 'read-write' });
    });

    it("the user's erasure removes their markers, and no one else's", async () => {
      const store = (await driver.open()).storage as Store;
      await complete(store, 'u1', 'read-write', 'enc-rw');
      await complete(store, 'u2', 'read-write', 'enc-rw-u2');
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-rw', Date.now() + DAY));
      await store.upsertOAuthRow(rejectedYnabTokenRow('u2', 'enc-rw-u2', Date.now() + DAY));
      expect(await store.deleteUserData('u1')).toBe(true);
      expect(await store.findOAuthRow(rejectedYnabTokenKey('u1', 'enc-rw'))).toBeUndefined();
      expect((await store.findOAuthRow(rejectedYnabTokenKey('u2', 'enc-rw-u2')))?.model).toBe('YnabTokenRejected');
    });

    it('the sweep removes an expired marker and keeps an unexpired one', async () => {
      const store = (await driver.open()).storage as Store;
      const now = Date.now();
      await complete(store, 'u1', 'read-write', 'enc-rw');
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-old', now - DAY));
      await store.upsertOAuthRow(rejectedYnabTokenRow('u1', 'enc-rw', now + DAY));
      const result = await store.sweepExpired({ now });
      expect(result.ran).toBe(true);
      expect(await store.findOAuthRow(rejectedYnabTokenKey('u1', 'enc-old'))).toBeUndefined();
      expect((await store.findOAuthRow(rejectedYnabTokenKey('u1', 'enc-rw')))?.model).toBe('YnabTokenRejected');
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
