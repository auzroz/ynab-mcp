/**
 * #54e: the inactive-user erase (D-5), on every storage driver: the
 * candidate listing, `deleteUserData`'s inactive-user condition (re-checked
 * inside its transaction), the job, the `MCP_INACTIVE_USER_DAYS` setting,
 * and schema 6's `last_seen_at` backfill.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OAuthRowStore, OAuthRowWrite, Storage } from '../../../src/storage/types.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import { eraseInactiveUsers, inactiveUserJob } from '../../../src/auth/inactive-user-job.js';
import { loadInactiveUserSettings } from '../../../src/config/http/inactive-users.js';
import { ConfigProblems } from '../../../src/config/parse.js';
import type { ExtensionContext } from '../../../src/http/extensions.js';
import type { HttpConfig } from '../../../src/config/http/index.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';

type Store = Storage & OAuthRowStore;

const DAY = 86_400_000;
/** Refresh tokens outlive the 31 days these tests jump ahead, so a 0.4.x grant can still be live then. */
const RETENTION = { refreshTokenIdleMs: 60 * DAY, refreshTokenTtlMs: 90 * DAY };
const blank = { payload: '{}', grantId: undefined, accountId: undefined, clientId: undefined, uid: undefined, expiresAt: undefined };

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupDrivers();
});

async function seedUser(s: Storage, userId: string): Promise<void> {
  await s.upsertUser({ userId, grantedScope: 'read-only', encryptedRefreshToken: `enc-${userId}`, updatedAt: Date.now() });
}

/** A client and a grant of `userId`'s; returns a token row under it to save. */
async function grantFor(s: Store, userId: string, model: 'AccessToken' | 'RefreshToken', expiresAt: number): Promise<OAuthRowWrite> {
  const clientId = `c-${randomUUID()}`;
  const grantId = `g-${randomUUID()}`;
  await s.upsertOAuthRow({ ...blank, key: plainRowKey('Client', clientId), model: 'Client', clientId });
  await s.upsertOAuthRow({
    ...blank,
    key: plainRowKey('Grant', grantId),
    model: 'Grant',
    grantId,
    accountId: userId,
    clientId,
    expiresAt: Date.now() + 100 * DAY,
  });
  return { ...blank, key: `h1.${randomUUID()}`, model, grantId, accountId: userId, clientId, expiresAt };
}

async function lastSeen(h: DriverHandle, userId: string): Promise<number | null> {
  const [row] = await (h.sql as NonNullable<DriverHandle['sql']>)('SELECT last_seen_at FROM users WHERE user_id = $1', [userId]);
  return row?.['last_seen_at'] == null ? null : Number(row['last_seen_at']);
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`inactive-user erase (#54e): ${driver.name}`, () => {
    it('erases a user not seen for the window and with no live grant, logging a count only', async () => {
      const h = await driver.open({ retention: RETENTION });
      await seedUser(h.storage, 'idle-user');
      await seedUser(h.storage, 'other-idle');
      const later = Date.now() + 31 * DAY;
      vi.useFakeTimers({ toFake: ['Date'], now: later - 2 * DAY });
      await seedUser(h.storage, 'recent-user'); // seen two days before the pass
      vi.useRealTimers();

      const lines: string[] = [];
      const result = await eraseInactiveUsers(h.storage, 30, { now: () => later, log: (m) => lines.push(m), pageSize: 1 });
      expect(result).toEqual({ erased: 2, failed: 0 });
      expect(await h.storage.getUser('idle-user')).toBeUndefined();
      expect(await h.storage.getUser('other-idle')).toBeUndefined();
      expect(await h.storage.getUser('recent-user')).toBeDefined();
      expect(Object.values(await h.userRows('idle-user')).every((n) => n === 0)).toBe(true);
      expect(lines).toEqual(['[InactiveUsers] erased 2 user(s) not seen for 30 days and with no live grant']);

      // Nothing left to erase: nothing logged.
      lines.length = 0;
      expect(await eraseInactiveUsers(h.storage, 30, { now: () => later, log: (m) => lines.push(m) })).toEqual({ erased: 0, failed: 0 });
      expect(lines).toEqual([]);
    });

    it('keeps a user with a live grant: an MCP token, a 0.4.x refresh token, or a sign-in in flight', async () => {
      const h = await driver.open({ retention: RETENTION });
      const s = h.storage as Store;
      const later = Date.now() + 31 * DAY;
      for (const id of ['oidc', 'legacy', 'signing-in', 'expired']) await seedUser(s, id);
      expect(await s.saveGrantToken(await grantFor(s, 'oidc', 'RefreshToken', later + DAY))).toBe(true);
      await s.saveRefreshToken({ token: `h1.${randomUUID()}`, clientId: 'c', userId: 'legacy', scopes: [], familyId: 'f1' });
      const grant = await grantFor(s, 'signing-in', 'AccessToken', later + DAY);
      expect(
        await s.stageSignIn({
          grantId: grant.grantId as string,
          user: { userId: 'signing-in', grantedScope: 'read-only', encryptedRefreshToken: 'enc', updatedAt: Date.now() },
          expiresAt: later + DAY,
        })
      ).toBe(true);
      // A token that expired before the pass is no live grant.
      expect(await s.saveGrantToken(await grantFor(s, 'expired', 'AccessToken', later - DAY))).toBe(true);

      const result = await eraseInactiveUsers(s, 30, { now: () => later, log: () => undefined });
      expect(result.erased).toBe(1);
      expect(await s.getUser('expired')).toBeUndefined();
      for (const id of ['oidc', 'legacy', 'signing-in']) expect(await s.getUser(id)).toBeDefined();
    });

    it('re-checks inside the erase: a sign-in or a new grant after the listing keeps the user', async () => {
      const h = await driver.open({ retention: RETENTION });
      const s = h.storage as Store;
      await seedUser(s, 'u1');
      await seedUser(s, 'u2');
      const later = Date.now() + 31 * DAY;
      const condition = { seenBefore: later - 30 * DAY, now: later };
      expect(await s.listInactiveUsers(condition.seenBefore, undefined, 10)).toEqual(['u1', 'u2']);

      // u1 signs in again after the listing (last_seen_at moves on).
      vi.useFakeTimers({ toFake: ['Date'], now: later - DAY });
      await seedUser(s, 'u1');
      vi.useRealTimers();
      expect(await s.deleteUserData('u1', condition)).toBe(false);
      expect(await s.getUser('u1')).toBeDefined();

      // u2 gets a live MCP token after the listing.
      expect(await s.saveGrantToken(await grantFor(s, 'u2', 'AccessToken', later + DAY))).toBe(true);
      expect(await s.deleteUserData('u2', condition)).toBe(false);
      expect(await s.getUser('u2')).toBeDefined();

      // An unknown user is not erased either; without the condition, the erase is unconditional.
      expect(await s.deleteUserData('nobody', condition)).toBe(false);
      expect(await s.deleteUserData('u2')).toBe(true);
      expect(await s.getUser('u2')).toBeUndefined();
    });

    it('starts the clock at every sign-in, re-consent and YNAB refresh write-back', async () => {
      const h = await driver.open();
      const t0 = Date.now();
      await seedUser(h.storage, 'u1');
      expect((await h.storage.getUser('u1'))?.lastSeenAt).toBeGreaterThanOrEqual(t0);
      const before = await h.storage.getUser('u1');
      const stored = await h.storage.updateUserRefreshToken('u1', before?.encryptedRefreshToken ?? '', 'enc-next', {
        encryptedAccessToken: 'v2.1.a.b.c',
        expiresAt: t0 + 10 * DAY,
        now: t0 + 5 * DAY,
      });
      expect(stored?.lastSeenAt).toBe(t0 + 5 * DAY);
      expect(stored?.updatedAt).toBe(t0 + 5 * DAY);
    });

    if (driver.kind !== 'memory') {
      it('schema 6 starts last_seen_at at the upgrade for older rows, once, and never lists a row without one', async () => {
        const h = await driver.open();
        const sql = h.sql as NonNullable<DriverHandle['sql']>;
        await seedUser(h.storage, 'old');
        await seedUser(h.storage, 'new');
        // As a row from before the upgrade (or a 0.4.x replica since): no clock yet.
        await sql('UPDATE users SET last_seen_at = NULL WHERE user_id = $1', ['old']);
        const far = Date.now() + 400 * DAY;
        expect(await h.storage.listInactiveUsers(far, undefined, 10)).toEqual(['new']);
        expect(await h.storage.deleteUserData('old', { seenBefore: far, now: far })).toBe(false);

        const upgrade = Date.now() + DAY;
        vi.useFakeTimers({ toFake: ['Date'], now: upgrade });
        await h.reopen();
        expect(await lastSeen(h, 'old')).toBe(upgrade);
        const newSeen = await lastSeen(h, 'new');
        expect(newSeen).toBeLessThan(upgrade);
        // A later restart changes nothing.
        vi.setSystemTime(upgrade + DAY);
        await h.reopen();
        expect(await lastSeen(h, 'old')).toBe(upgrade);
        expect(await lastSeen(h, 'new')).toBe(newSeen);
      });
    }

    if (driver.kind === 'postgres') {
      it('an erase racing a token mint on another replica: either the user is erased and the mint refused, or both kept', async () => {
        const h = await driver.open({ retention: RETENTION });
        const other = (await h.reopen({ retention: RETENTION })) as Store;
        const s = h.storage as Store;
        const later = Date.now() + 31 * DAY;
        const outcomes = new Set<string>();
        for (let i = 0; i < 12; i++) {
          const userId = `race-${i}`;
          await seedUser(s, userId);
          const token = await grantFor(s, userId, 'AccessToken', later + DAY);
          const [erased, minted] = await Promise.all([
            s.deleteUserData(userId, { seenBefore: later - 30 * DAY, now: later }),
            other.saveGrantToken(token),
          ]);
          const user = await s.getUser(userId);
          expect(erased).toBe(!minted);
          expect(user === undefined).toBe(erased);
          outcomes.add(erased ? 'erased' : 'kept');
        }
        expect(outcomes.size).toBeGreaterThan(0);
      });
    }
  });
}

describe('MCP_INACTIVE_USER_DAYS (#54e)', () => {
  const load = (value: string | undefined): { days: number | undefined; problems: number } => {
    const problems = new ConfigProblems();
    const { inactiveUserDays } = loadInactiveUserSettings({ env: { MCP_INACTIVE_USER_DAYS: value }, problems });
    return { days: inactiveUserDays, problems: problems.count };
  };

  it('is off when unset or empty', () => {
    expect(load(undefined)).toEqual({ days: undefined, problems: 0 });
    expect(load('')).toEqual({ days: undefined, problems: 0 });
  });

  it('accepts 30 to 3650 days', () => {
    expect(load('30')).toEqual({ days: 30, problems: 0 });
    expect(load('365')).toEqual({ days: 365, problems: 0 });
    expect(load('3650')).toEqual({ days: 3650, problems: 0 });
  });

  it.each(['0', '29', '3651', '30d', ' 30', '-30', '1e3', 'off', '90.5'])('refuses %j', (value) => {
    expect(load(value)).toEqual({ days: undefined, problems: 1 });
  });
});

describe('the inactive-user job extension', () => {
  const ctx = (days: number | undefined, storage: Storage | undefined): ExtensionContext => ({
    config: { inactiveUserDays: days } as HttpConfig,
    storage,
  });

  it('does not start when the setting is off or there is no storage', async () => {
    const h = await testDrivers[0]!.open();
    expect(inactiveUserJob.start(ctx(undefined, h.storage))).toBeUndefined();
    expect(inactiveUserJob.start(ctx(30, undefined))).toBeUndefined();
  });

  it('starts and stops when it is on', async () => {
    const h = await testDrivers[0]!.open();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = inactiveUserJob.start(ctx(30, h.storage));
    expect(handle).toBeDefined();
    await handle?.stop();
  });
});
