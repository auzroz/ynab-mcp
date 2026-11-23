/**
 * At-rest key rotation (#57b), against every storage driver (memory always,
 * SQLite when it loads, Postgres with DATABASE_URL; REQUIRE_DB_TESTS=1 makes a
 * missing one fail):
 *
 *   - the CiphertextStore contract: the listing, the compare-and-set rekey
 *     (no `updated_at` stamp), the staged sign-ins, the floor (monotonic,
 *     shared by replicas) and the per-key check;
 *   - the startup key check and floor;
 *   - the rekey job: v1 and older-key rows rewritten, every row readable
 *     throughout, a staged sign-in and a newer key holding retirement back,
 *     the grace period, retirement on every replica, two replicas at once;
 *   - the log line carries counts only.
 *
 * Keys are generated here; none is real.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  Encryptor,
  encrypt as encryptV1,
  parseEncryptionKey,
  refreshTokenContext,
  accessTokenContext,
} from '../../../src/crypto.js';
import { prepareEncryptionKeys, rekeyPass, startRekeyJob, type RekeyState } from '../../../src/auth/rekey-job.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import type { OAuthRowStore, Storage } from '../../../src/storage/types.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';

type Store = Storage & OAuthRowStore;

const blank = { payload: '{}', grantId: undefined, accountId: undefined, clientId: undefined, uid: undefined, expiresAt: undefined };

const newKey = (): string => randomBytes(32).toString('base64');
const MINUTE = 60_000;

async function addUser(store: Storage, userId: string, ciphertext: string, updatedAt = 1_000): Promise<void> {
  await store.upsertUser({ userId, grantedScope: 'read-only', encryptedRefreshToken: ciphertext, updatedAt });
}

async function stageSignIn(store: Store, userId: string, ciphertext: string, ttlMs = 10 * MINUTE): Promise<void> {
  const clientId = `c-${randomUUID()}`;
  const grantId = `g-${randomUUID()}`;
  await store.upsertOAuthRow({ ...blank, key: plainRowKey('Client', clientId), model: 'Client', clientId });
  await store.upsertOAuthRow({
    ...blank,
    key: plainRowKey('Grant', grantId),
    model: 'Grant',
    grantId,
    accountId: userId,
    clientId,
    expiresAt: Date.now() + 3_600_000,
  });
  const staged = await store.stageSignIn({
    grantId,
    user: { userId, grantedScope: 'read-only', encryptedRefreshToken: ciphertext, updatedAt: Date.now() },
    expiresAt: Date.now() + ttlMs,
  });
  expect(staged).toBe(true);
}

/** A clock the test moves. */
function clock(start = Date.now()): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

describe.each(testDrivers)('encryption rotation: $name', (driver) => {
  describe.skipIf(!driver.enabled)(driver.name, () => {
    const open = async (): Promise<{ handle: DriverHandle; store: Store }> => {
      const handle = await driver.open();
      return { handle, store: handle.storage as Store };
    };

    // ---- CiphertextStore -------------------------------------------------

    it('lists users not under the current prefix, by user id, in pages', async () => {
      const { store } = await open();
      await addUser(store, 'u-c', 'v2.2.a.b.c');
      await addUser(store, 'u-a', 'v1.a.b.c');
      await addUser(store, 'u-b', 'v2.1.a.b.c');
      await addUser(store, 'u-d', 'v2.12.a.b.c'); // id 12 is not id 1 or 2
      const first = await store.listUserCiphertextsNotIn('v2.2.', undefined, 2);
      expect(first).toEqual([
        { userId: 'u-a', encryptedRefreshToken: 'v1.a.b.c' },
        { userId: 'u-b', encryptedRefreshToken: 'v2.1.a.b.c' },
      ]);
      const second = await store.listUserCiphertextsNotIn('v2.2.', 'u-b', 2);
      expect(second).toEqual([{ userId: 'u-d', encryptedRefreshToken: 'v2.12.a.b.c' }]);
      expect(await store.listUserCiphertextsNotIn('v2.1.', undefined, 10)).toHaveLength(3);
    });

    it('rekeys with a compare-and-set that stamps nothing else', async () => {
      const { store } = await open();
      await addUser(store, 'u', 'old', 1_234);
      expect(await store.rekeyUserRefreshToken('u', 'stale', 'new')).toBe(false);
      expect(await store.rekeyUserRefreshToken('missing', 'old', 'new')).toBe(false);
      expect(await store.rekeyUserRefreshToken('u', 'old', 'new')).toBe(true);
      const user = await store.getUser('u');
      expect(user?.encryptedRefreshToken).toBe('new');
      expect(user?.updatedAt).toBe(1_234);
      expect(await store.rekeyUserRefreshToken('u', 'old', 'newer')).toBe(false);
    });

    it('lists the ciphertexts of unexpired staged sign-ins', async () => {
      const { store } = await open();
      await addUser(store, 'u1', 'x');
      await addUser(store, 'u2', 'x');
      await stageSignIn(store, 'u1', 'v1.staged.live.ct');
      await stageSignIn(store, 'u2', 'v2.1.staged.short.ct', 1_000);
      expect((await store.listStagedSignInCiphertexts(Date.now())).sort()).toEqual([
        'v1.staged.live.ct',
        'v2.1.staged.short.ct',
      ]);
      expect(await store.listStagedSignInCiphertexts(Date.now() + 5_000)).toEqual(['v1.staged.live.ct']);
    });

    it('keeps the highest floor, across replicas', async () => {
      const { handle, store } = await open();
      const replica = await handle.reopen();
      expect(await store.getRetiredKeyFloor()).toBe(0);
      expect(await store.raiseRetiredKeyFloor(3)).toBe(3);
      expect(await replica.raiseRetiredKeyFloor(2)).toBe(3);
      expect(await replica.getRetiredKeyFloor()).toBe(3);
      await Promise.all([store.raiseRetiredKeyFloor(10), replica.raiseRetiredKeyFloor(9)]);
      expect(await store.getRetiredKeyFloor()).toBe(10);
    });

    it('records a key check once and compares it after', async () => {
      const { handle, store } = await open();
      const replica = await handle.reopen();
      const a = 'a'.repeat(64);
      const b = 'b'.repeat(64);
      expect(await store.recordEncryptionKeyCheck(1, a)).toBe('recorded');
      expect(await replica.recordEncryptionKeyCheck(1, a)).toBe('matches');
      expect(await replica.recordEncryptionKeyCheck(1, b)).toBe('differs');
      expect(await store.recordEncryptionKeyCheck(2, b)).toBe('recorded');
    });

    if (driver.kind !== 'memory') {
      it('refuses an unreadable stored floor', async () => {
        const { handle, store } = await open();
        await handle.sql?.("INSERT INTO schema_meta (key, value) VALUES ('encryption_retired_below', 'two')");
        await expect(store.getRetiredKeyFloor()).rejects.toThrow(/unreadable encryption_retired_below/);
      });
    }

    // ---- startup -----------------------------------------------------------

    it('refuses a different key under a recorded id, and a key id below the floor', async () => {
      const { handle, store } = await open();
      const k1 = newKey();
      await prepareEncryptionKeys(store, new Encryptor(k1));
      // A restart with the same key is fine, on any replica.
      await prepareEncryptionKeys(await handle.reopen(), new Encryptor(k1));

      const other = newKey();
      const error = await prepareEncryptionKeys(store, new Encryptor(other)).then(
        () => undefined,
        (e: unknown) => e as Error
      );
      expect(error?.message).toMatch(/id 1 is not the key this database recorded/);
      for (const secret of [k1, other]) expect(error?.message).not.toContain(secret);

      // A new key under a new id is recorded; then the floor moves to 2.
      await prepareEncryptionKeys(store, new Encryptor(other, { keyId: '2', previousKeys: `1:${k1}` }));
      await store.raiseRetiredKeyFloor(2);
      await expect(prepareEncryptionKeys(store, new Encryptor(k1))).rejects.toThrow(/ENCRYPTION_KEY_ID is older/);
      const current = new Encryptor(other, { keyId: '2' });
      await prepareEncryptionKeys(store, current);
      expect(current.retiredBelow).toBe(2);
    });

    // ---- the rekey job -----------------------------------------------------

    it('moves v1 and old-key rows to the current key, keeping every row readable, then retires', async () => {
      const { store } = await open();
      const k1 = newKey();
      const k2 = newKey();
      const before = new Encryptor(k1);
      await addUser(store, 'legacy', encryptV1('rt-legacy', parseEncryptionKey(k1)), 5_000);
      await addUser(store, 'old', before.encrypt('rt-old', refreshTokenContext('old')));

      const keyring = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` });
      await prepareEncryptionKeys(store, keyring);
      const read = async (userId: string, enc: Encryptor = keyring): Promise<string> =>
        enc.decrypt((await store.getUser(userId))!.encryptedRefreshToken, refreshTokenContext(userId));
      expect(await read('legacy')).toBe('rt-legacy');
      expect(await read('old')).toBe('rt-old');

      const lines: string[] = [];
      const c = clock();
      const state: RekeyState = {};
      const opts = { now: c.now, log: (m: string) => lines.push(m), graceMs: 60 * MINUTE };
      const first = await rekeyPass(store, keyring, state, opts);
      expect(first).toMatchObject({ rekeyed: 2, remaining: 0, unreadable: 0, retiredBelow: 0, retiredNow: false });
      expect(await read('legacy')).toBe('rt-legacy');
      expect(await read('old')).toBe('rt-old');
      expect((await store.getUser('legacy'))?.encryptedRefreshToken.startsWith('v2.2.')).toBe(true);
      expect((await store.getUser('legacy'))?.updatedAt).toBe(5_000);
      expect(lines).toEqual(['[Rekey] re-encrypted 2, 0 remaining']);

      // Nothing left: retired only after the grace period, and logged once.
      c.advance(30 * MINUTE);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(false);
      c.advance(31 * MINUTE);
      const retired = await rekeyPass(store, keyring, state, opts);
      expect(retired).toMatchObject({ retiredNow: true, retiredBelow: 2 });
      expect(await store.getRetiredKeyFloor()).toBe(2);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/v1 format and key ids below 2 are now refused/);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(false);
      expect(lines).toHaveLength(2);

      // A v1 or key-1 ciphertext planted after retirement is refused.
      await addUser(store, 'planted', encryptV1('rt-planted', parseEncryptionKey(k1)));
      await expect(read('planted')).rejects.toThrow(/retired/);
      const after = await rekeyPass(store, keyring, state, opts);
      expect(after).toMatchObject({ rekeyed: 0, unreadable: 1, remaining: 0 });
      expect((await store.getUser('planted'))?.encryptedRefreshToken.startsWith('v1.')).toBe(true);

      // The log lines carry counts only.
      for (const line of lines) {
        for (const secret of [k1, k2, 'rt-legacy', 'rt-old', 'legacy', 'planted']) expect(line).not.toContain(secret);
      }
    });

    it('does not launder a swapped ciphertext into the row it was copied to', async () => {
      const { store } = await open();
      const k1 = newKey();
      const keyring = new Encryptor(newKey(), { keyId: '2', previousKeys: `1:${k1}` });
      const aliceCt = new Encryptor(k1).encrypt('rt-alice', refreshTokenContext('alice'));
      await addUser(store, 'alice', aliceCt);
      await addUser(store, 'mallory', aliceCt); // copied into another user's row
      const result = await rekeyPass(store, keyring, {}, { log: () => undefined });
      expect(result).toMatchObject({ rekeyed: 1, unreadable: 1 });
      expect((await store.getUser('mallory'))?.encryptedRefreshToken).toBe(aliceCt);
    });

    it('holds retirement back for staged sign-ins, newer keys and keys not configured', async () => {
      const { store } = await open();
      const k1 = newKey();
      const k2 = newKey();
      const k3 = newKey();
      const keyring = new Encryptor(k2, { keyId: '5', previousKeys: `1:${k1}` });
      await addUser(store, 'signing-in', 'x');
      await stageSignIn(store, 'signing-in', new Encryptor(k1).encrypt('rt-staged', refreshTokenContext('signing-in')));
      await addUser(store, 'newer', new Encryptor(k3, { keyId: '6' }).encrypt('rt-newer', refreshTokenContext('newer')));
      await addUser(store, 'lost', new Encryptor(newKey(), { keyId: '1' }).encrypt('rt', refreshTokenContext('lost')));
      await addUser(store, 'no-key', 'v2.3.AAAA.AAAA.AAAA');

      const lines: string[] = [];
      const c = clock();
      const state: RekeyState = {};
      const opts = { now: c.now, log: (m: string) => lines.push(m), graceMs: MINUTE };
      // 'x' is in neither format: unreadable. 'lost' is under id 1 but another key: unreadable.
      const r = await rekeyPass(store, keyring, state, opts);
      expect(r).toMatchObject({ rekeyed: 0, staged: 1, newer: 1, noKey: 1, unreadable: 2, remaining: 2 });
      expect((await store.getUser('newer'))?.encryptedRefreshToken.startsWith('v2.6.')).toBe(true);
      c.advance(2 * MINUTE);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(false);
      c.advance(2 * MINUTE);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(false);
      expect(await store.getRetiredKeyFloor()).toBe(0);
      // The unchanged state is logged once.
      expect(lines).toEqual([
        '[Rekey] re-encrypted 0, 2 remaining (1 staged sign-ins, 1 under a newer key id); 1 under a key id that is not configured (retirement waits for them: add the key to ENCRYPTION_KEY_PREVIOUS); 2 unreadable (those users must connect again)',
      ]);
    });

    it('a row under a lost key holds retirement back until its user reconnects or is erased', async () => {
      const { store } = await open();
      const keyring = new Encryptor(newKey(), { keyId: '2' }); // key 1 is lost
      const lostKey = new Encryptor(newKey());
      await addUser(store, 'reconnects', lostKey.encrypt('rt', refreshTokenContext('reconnects')));
      await addUser(store, 'erased', lostKey.encrypt('rt', refreshTokenContext('erased')));
      const c = clock();
      const state: RekeyState = {};
      const opts = { now: c.now, log: () => undefined, graceMs: MINUTE };
      expect(await rekeyPass(store, keyring, state, opts)).toMatchObject({ noKey: 2, remaining: 0 });
      c.advance(2 * MINUTE);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(false);
      // One user signs in again (the row is replaced under the current key); the other is erased.
      await addUser(store, 'reconnects', keyring.encrypt('rt-new', refreshTokenContext('reconnects')));
      await store.deleteUserData('erased');
      expect(await rekeyPass(store, keyring, state, opts)).toMatchObject({ noKey: 0, remaining: 0, retiredNow: false });
      c.advance(2 * MINUTE);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(true);
      expect(await store.getRetiredKeyFloor()).toBe(2);
    });

    it('a replica that has the next key only to read it leaves rows under it alone (two-phase rollout)', async () => {
      const { store } = await open();
      const k1 = newKey();
      const k2 = newKey();
      // Phase A on this replica: key 1 current, key 2 read-only.
      const phaseA = new Encryptor(k1, { keyId: '1', previousKeys: `2:${k2}` });
      await prepareEncryptionKeys(store, phaseA);
      // Another replica is already on phase B and wrote under key 2.
      const underTwo = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` }).encrypt('rt-b', refreshTokenContext('b'));
      await addUser(store, 'b', underTwo);
      expect(phaseA.decrypt(underTwo, refreshTokenContext('b'))).toBe('rt-b');
      const r = await rekeyPass(store, phaseA, {}, { log: () => undefined });
      expect(r).toMatchObject({ rekeyed: 0, newer: 1, remaining: 1 });
      expect((await store.getUser('b'))?.encryptedRefreshToken).toBe(underTwo);
    });

    it('converges when two replicas run passes at once', async () => {
      const { handle, store } = await open();
      const replica = await handle.reopen();
      const k1 = newKey();
      const k2 = newKey();
      const before = new Encryptor(k1);
      const ids = Array.from({ length: 30 }, (_, i) => `user-${String(i).padStart(2, '0')}`);
      for (const id of ids) await addUser(store, id, before.encrypt(`rt-${id}`, refreshTokenContext(id)));

      const a = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` });
      const b = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` });
      const c = clock();
      const sa: RekeyState = {};
      const sb: RekeyState = {};
      const opts = { now: c.now, log: () => undefined, graceMs: MINUTE, pageSize: 7 };
      const [ra, rb] = await Promise.all([rekeyPass(store, a, sa, opts), rekeyPass(replica, b, sb, opts)]);
      expect(ra.rekeyed + rb.rekeyed).toBe(ids.length);
      expect(ra.unreadable + rb.unreadable).toBe(0);
      for (const id of ids) {
        const stored = (await store.getUser(id))!.encryptedRefreshToken;
        expect(stored.startsWith('v2.2.')).toBe(true);
        expect(a.decrypt(stored, refreshTokenContext(id))).toBe(`rt-${id}`);
      }
      // Both see nothing left, then both retire; the floor is shared.
      c.advance(2 * MINUTE);
      const [fa, fb] = await Promise.all([rekeyPass(store, a, sa, opts), rekeyPass(replica, b, sb, opts)]);
      c.advance(2 * MINUTE);
      await Promise.all([rekeyPass(store, a, sa, opts), rekeyPass(replica, b, sb, opts)]);
      expect([fa.remaining, fb.remaining]).toEqual([0, 0]);
      expect(await store.getRetiredKeyFloor()).toBe(2);
      expect([a.retiredBelow, b.retiredBelow]).toEqual([2, 2]);

      // A third replica that only reads the floor refuses v1 too.
      const late = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` });
      await rekeyPass(replica, late, {}, { log: () => undefined });
      expect(late.retiredBelow).toBe(2);
    });

    it('a replica whose key id is below the floor fails its pass, loudly', async () => {
      const { store } = await open();
      await store.raiseRetiredKeyFloor(2);
      await expect(rekeyPass(store, new Encryptor(newKey()), {}, { log: () => undefined })).rejects.toThrow(
        /ENCRYPTION_KEY_ID is older/
      );
    });

    // ---- the shared YNAB access token (#48) ---------------------------------

    /** Store `accessCt` as `userId`'s shared access token, expiring at `expiresAt`. */
    async function share(store: Store, userId: string, accessCt: string, expiresAt: number): Promise<void> {
      const row = await store.getUser(userId);
      const ct = row?.encryptedRefreshToken ?? '';
      await store.updateUserRefreshToken(userId, ct, ct, { encryptedAccessToken: accessCt, expiresAt, now: Date.now() });
    }

    it('lists and rewrites a shared access token under an older key, with its own context, and counts it', async () => {
      const { store } = await open();
      const k1 = newKey();
      const before = new Encryptor(k1);
      const keyring = new Encryptor(newKey(), { keyId: '2', previousKeys: `1:${k1}` });
      // The refresh token is already current; only the access token is under key 1.
      await addUser(store, 'u', keyring.encrypt('rt', refreshTokenContext('u')));
      await share(store, 'u', before.encrypt('at', accessTokenContext('u')), Date.now() + 3_600_000);
      expect((await store.listUserCiphertextsNotIn(keyring.currentPrefix, undefined, 10)).map((r) => r.userId)).toEqual(['u']);

      const lines: string[] = [];
      const c = clock();
      const state: RekeyState = {};
      const opts = { now: c.now, log: (m: string) => lines.push(m), graceMs: 60 * MINUTE };
      const result = await rekeyPass(store, keyring, state, opts);
      expect(result).toMatchObject({ rekeyed: 0, accessRekeyed: 1, accessDropped: 0, remaining: 0 });
      const row = await store.getUser('u');
      expect(row?.encryptedAccessToken?.startsWith('v2.2.')).toBe(true);
      expect(keyring.decrypt(row?.encryptedAccessToken ?? '', accessTokenContext('u'))).toBe('at');
      expect(lines).toEqual(['[Rekey] re-encrypted 0, 0 remaining; shared access tokens: 1 re-encrypted, 0 dropped']);
      expect(await store.listUserCiphertextsNotIn(keyring.currentPrefix, undefined, 10)).toEqual([]);

      // Key 1 retires once the grace period has passed: nothing is left under it.
      c.advance(61 * MINUTE);
      expect((await rekeyPass(store, keyring, state, opts)).retiredNow).toBe(true);
      for (const line of lines) for (const secret of ['at', 'rt', k1]) expect(line).not.toContain(` ${secret} `);
    });

    it('drops an expired or unreadable shared access token instead of holding retirement back', async () => {
      const { store } = await open();
      const k1 = newKey();
      const before = new Encryptor(k1);
      const keyring = new Encryptor(newKey(), { keyId: '2', previousKeys: `1:${k1}` });
      for (const id of ['expired', 'swapped', 'lost-key']) await addUser(store, id, keyring.encrypt('rt', refreshTokenContext(id)));
      await share(store, 'expired', before.encrypt('at', accessTokenContext('expired')), Date.now() - 1);
      await share(store, 'swapped', before.encrypt('at', accessTokenContext('someone-else')), Date.now() + 3_600_000);
      await share(store, 'lost-key', new Encryptor(newKey(), { keyId: '7' }).encrypt('at', accessTokenContext('lost-key')).replace(/^v2\.7\./, 'v2.1.'), Date.now() + 3_600_000);

      const result = await rekeyPass(store, keyring, {}, { log: () => undefined });
      expect(result).toMatchObject({ accessRekeyed: 0, accessDropped: 3, remaining: 0, noKey: 0, unreadable: 0 });
      for (const id of ['expired', 'swapped', 'lost-key']) {
        const row = await store.getUser(id);
        expect(row?.encryptedAccessToken).toBeUndefined();
        expect(row?.accessTokenExpiresAt).toBeUndefined();
        // The refresh token is untouched.
        expect(keyring.decrypt(row?.encryptedRefreshToken ?? '', refreshTokenContext(id))).toBe('rt');
      }
    });

    it('leaves a shared access token under a newer key alone, and a lost compare-and-set holds retirement back', async () => {
      const { store } = await open();
      const k1 = newKey();
      const keyring = new Encryptor(k1);
      const newer = new Encryptor(newKey(), { keyId: '2', previousKeys: `1:${k1}` });
      await addUser(store, 'u', keyring.encrypt('rt', refreshTokenContext('u')));
      await share(store, 'u', newer.encrypt('at', accessTokenContext('u')), Date.now() + 3_600_000);
      expect(await rekeyPass(store, keyring, {}, { log: () => undefined })).toMatchObject({ newer: 1, remaining: 1, accessRekeyed: 0 });

      // A refresh replaced the token between the listing and the write.
      const current = new Encryptor(newKey(), { keyId: '3', previousKeys: `1:${k1}` });
      await share(store, 'u', keyring.encrypt('at', accessTokenContext('u')), Date.now() + 3_600_000);
      const listing = store.listUserCiphertextsNotIn.bind(store);
      vi.spyOn(store, 'listUserCiphertextsNotIn').mockImplementationOnce(async (...args) => {
        const page = await listing(...args);
        await share(store, 'u', current.encrypt('at-next', accessTokenContext('u')), Date.now() + 3_600_000);
        return page;
      });
      expect(await rekeyPass(store, current, {}, { log: () => undefined })).toMatchObject({ changed: 1, remaining: 1 });
      expect(current.decrypt((await store.getUser('u'))?.encryptedAccessToken ?? '', accessTokenContext('u'))).toBe('at-next');
    });

    it('runs as a job: first pass, then stop() waits for it', async () => {
      const { store } = await open();
      const k1 = newKey();
      await addUser(store, 'u', encryptV1('rt', parseEncryptionKey(k1)));
      const keyring = new Encryptor(k1);
      const logs: string[] = [];
      const job = startRekeyJob(store, keyring, { firstPassMs: 0, intervalMs: 60_000, log: (m) => logs.push(m) });
      await vi.waitFor(() => expect(logs).toHaveLength(1));
      await job.stop();
      expect((await store.getUser('u'))?.encryptedRefreshToken.startsWith('v2.1.')).toBe(true);
    });
  });
});
