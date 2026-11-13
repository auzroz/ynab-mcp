/**
 * STOR-1 (#53a, #54a) on every storage driver: account erasure, the
 * account-generation invariant, the compare-and-set YNAB write-back, refresh
 * token expiry, the account self-service methods, `sweepExpired`, and the M2
 * migration from an M1 database. The Postgres races run on two pools and wait
 * on `pg_stat_activity`, never on sleeps.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type {
  Storage,
  AccessTokenRecord,
  RefreshTokenRecord,
  StorageDriverOptions,
} from '../../../src/storage/types.js';
import { createAccountStore } from '../../../src/storage/account-store.js';
import {
  ADDED_COLUMNS,
  ADDED_INDEXES,
  ADDED_TABLES,
  applyMigrations,
  SCHEMA_VERSION,
  type MigrationTx,
  type MigrationPlan,
} from '../../../src/storage/migrations.js';
import { DEFAULT_RETENTION, retentionPolicy } from '../../../src/auth/retention-defaults.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { TEST_TOKEN_HASHER } from '../helpers/token-hasher.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const IDLE = DEFAULT_RETENTION.refreshTokenIdleMs;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupDrivers();
});

function client(clientId: string = `client-${randomUUID()}`): OAuthClientInformationFull {
  return {
    client_id: clientId,
    client_name: `App ${clientId}`,
    redirect_uris: ['https://client.example/cb'],
  } as OAuthClientInformationFull;
}

async function seedUser(s: Storage, userId: string, token = `enc-${userId}`): Promise<void> {
  await s.upsertUser({ userId, grantedScope: 'read-write', encryptedRefreshToken: token, updatedAt: Date.now() });
}

function accessToken(userId: string, clientId: string, familyId?: string, ttl = 60_000): AccessTokenRecord {
  return {
    token: `at-${randomUUID()}`,
    clientId,
    userId,
    scopes: ['ynab'],
    expiresAt: Date.now() + ttl,
    grantedScope: 'read-write',
    ...(familyId !== undefined ? { familyId } : {}),
  };
}

function refreshToken(userId: string, clientId: string, familyId?: string): RefreshTokenRecord {
  return {
    token: `rt-${randomUUID()}`,
    clientId,
    userId,
    scopes: ['ynab'],
    grantedScope: 'read-write',
    ...(familyId !== undefined ? { familyId } : {}),
  };
}

/** A code issued and spent (its tombstone written), but not yet exchanged. */
async function spentCode(s: Storage, userId: string, clientId: string): Promise<{ code: string; familyId: string }> {
  const code = `code-${randomUUID()}`;
  await s.saveAuthCode({
    code,
    clientId,
    userId,
    redirectUri: 'https://client.example/cb',
    codeChallenge: 'chal',
    scopes: ['ynab'],
    expiresAt: Date.now() + 600_000,
    grantedScope: 'read-write',
  });
  const familyId = randomUUID();
  expect(await s.consumeAuthCode(code, { familyId, consumedUntil: Date.now() + 600_000 })).toBeDefined();
  return { code, familyId };
}

/** A completed authorization: a new family with its first token pair. */
async function grant(
  s: Storage,
  userId: string,
  clientId: string
): Promise<{ familyId: string; access: AccessTokenRecord; refresh: RefreshTokenRecord }> {
  const { code, familyId } = await spentCode(s, userId, clientId);
  const access = accessToken(userId, clientId, familyId);
  const refresh = refreshToken(userId, clientId, familyId);
  expect(await s.saveCodeTokens(code, { familyId, accessToken: access, refreshToken: refresh })).toBe(true);
  return { familyId, access, refresh };
}

/** Rotate `rt` within its family; the new refresh token, or undefined when refused. */
async function rotate(
  s: Storage,
  rt: RefreshTokenRecord,
  consumedUntil = Date.now() + 30 * DAY
): Promise<RefreshTokenRecord | undefined> {
  const familyId = rt.familyId ?? randomUUID();
  const next = refreshToken(rt.userId, rt.clientId, familyId);
  const taken = await s.rotateRefreshToken(rt.token, {
    familyId,
    consumedUntil,
    accessToken: accessToken(rt.userId, rt.clientId, familyId),
    refreshToken: next,
  });
  return taken ? next : undefined;
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`STOR-1 retention and deletion: ${driver.name}`, () => {
    let h: DriverHandle;
    let s: Storage;

    async function open(options?: StorageDriverOptions): Promise<void> {
      h = await driver.open(options);
      s = h.storage;
    }

    beforeEach(async () => {
      await open();
    });

    describe('YNAB refresh write-back (compare-and-set)', () => {
      it('replaces the token only while it is still the one the refresh started from', async () => {
        await seedUser(s, 'u', 'old');
        const before = await s.getUser('u');
        expect(await s.updateUserRefreshToken('u', 'stale', 'new')).toBeUndefined();
        expect((await s.getUser('u'))?.encryptedRefreshToken).toBe('old');
        const written = await s.updateUserRefreshToken('u', 'old', 'new');
        const after = await s.getUser('u');
        expect(written).toEqual(after);
        expect(after?.encryptedRefreshToken).toBe('new');
        expect(after?.createdAt).toBe(before?.createdAt);
        expect(after?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
      });

      it('never inserts: a write-back for an erased user leaves no row', async () => {
        await seedUser(s, 'u', 'old');
        await s.deleteUserData('u');
        expect(await s.updateUserRefreshToken('u', 'old', 'new')).toBeUndefined();
        expect(await s.getUser('u')).toBeUndefined();
      });

      it('writes only the token: an access level changed by a re-consent is kept and returned', async () => {
        await seedUser(s, 'u', 'old'); // read-write
        await s.upsertUser({ userId: 'u', grantedScope: 'read-only', encryptedRefreshToken: 'old', updatedAt: Date.now() });
        const written = await s.updateUserRefreshToken('u', 'old', 'new');
        expect(written).toMatchObject({ grantedScope: 'read-only', encryptedRefreshToken: 'new' });
        expect((await s.getUser('u'))?.grantedScope).toBe('read-only');
      });
    });

    describe('account generation (issued_at >= users.created_at)', () => {
      it('a token whose user row is gone, or newer than the token, reads as unknown', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        await seedUser(s, 'u');
        const at = accessToken('u', 'c', 'f', 3_600_000);
        const rt = refreshToken('u', 'c', 'f');
        await s.saveAccessToken(at);
        await s.saveRefreshToken(rt);
        expect(await s.getAccessToken(at.token)).toBeDefined();

        await s.deleteUser('u'); // the row only: the tokens are orphans
        expect(await s.getAccessToken(at.token)).toBeUndefined();
        expect(await s.getRefreshToken(rt.token)).toBeUndefined();

        vi.setSystemTime(t0 + 1000);
        await seedUser(s, 'u'); // signs up again: a new generation
        expect((await s.getUser('u'))?.createdAt).toBe(t0 + 1000);
        expect(await s.getAccessToken(at.token)).toBeUndefined();
        expect(await s.getRefreshToken(rt.token)).toBeUndefined();
        expect(await rotate(s, rt)).toBeUndefined();
        expect(await s.getConsumedRefreshToken(rt.token)).toBeUndefined();
        expect(await s.listConnections('u')).toEqual([]);

        const fresh = accessToken('u', 'c', 'f2', 3_600_000);
        await s.saveAccessToken(fresh);
        expect(await s.getAccessToken(fresh.token)).toBeDefined();
      });

      it('a consent for an existing user keeps its generation, so its tokens stay valid', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await seedUser(s, 'u');
        const { access } = await grant(s, 'u', 'c');
        vi.setSystemTime(Date.now() + 5000);
        await seedUser(s, 'u', 'reconsented');
        expect(await s.getAccessToken(access.token)).toBeDefined();
      });

      it('saves no code tokens for a user without a row', async () => {
        await seedUser(s, 'u');
        const { code, familyId } = await spentCode(s, 'u', 'c');
        await s.deleteUser('u');
        const pair = { familyId, accessToken: accessToken('u', 'c', familyId), refreshToken: refreshToken('u', 'c', familyId) };
        expect(await s.saveCodeTokens(code, pair)).toBe(false);
        expect(await s.getAccessToken(pair.accessToken.token)).toBeUndefined();
      });
    });

    describe('refresh-token expiry', () => {
      it('an idle refresh token expires and is deleted, and its family is left alone', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        await seedUser(s, 'u');
        const { refresh, familyId } = await grant(s, 'u', 'c');

        vi.setSystemTime(t0 + IDLE);
        expect(await s.getRefreshToken(refresh.token)).toBeDefined(); // the limit itself is still valid
        const sibling = refreshToken('u', 'c', familyId);
        await s.saveRefreshToken(sibling);

        vi.setSystemTime(t0 + IDLE + 1);
        expect(await s.getRefreshToken(refresh.token)).toBeUndefined();
        expect(await rotate(s, refresh)).toBeUndefined();
        expect(await s.getConsumedRefreshToken(refresh.token)).toBeUndefined();
        expect(await s.getRefreshToken(sibling.token)).toBeDefined();
      });

      it('a family expires at its absolute limit however often it is refreshed', async () => {
        await open({ retention: { refreshTokenIdleMs: 10_000, refreshTokenTtlMs: 25_000 } });
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        await seedUser(s, 'u');
        await s.saveClient(client('c'));
        const { refresh, familyId } = await grant(s, 'u', 'c');
        let current: RefreshTokenRecord | undefined = refresh;
        for (const at of [8000, 16_000, 24_000]) {
          vi.setSystemTime(t0 + at);
          current = await rotate(s, current as RefreshTokenRecord);
          expect(current, `rotation at +${at} ms`).toBeDefined();
        }
        expect(await s.listConnections('u')).toEqual([
          {
            familyId,
            clientId: 'c',
            clientName: 'App c',
            grantedScope: 'read-write',
            createdAt: t0,
            lastUsedAt: t0 + 24_000,
            expiresAt: t0 + 25_000,
          },
        ]);

        vi.setSystemTime(t0 + 25_001);
        const last = current as RefreshTokenRecord;
        const next = await rotate(s, last);
        expect(next).toBeUndefined();
        expect(await s.getConsumedRefreshToken(last.token)).toBeUndefined();
        expect(await s.getRefreshToken(last.token)).toBeUndefined();
        expect(await s.listConnections('u')).toEqual([]);
      });

      it('takeRefreshToken returns nothing for an expired token', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await seedUser(s, 'u');
        const { refresh } = await grant(s, 'u', 'c');
        vi.setSystemTime(Date.now() + IDLE + 1);
        expect(await s.takeRefreshToken(refresh.token)).toBeUndefined();
      });
    });

    describe('deleteUserData', () => {
      it('leaves no row for the user in any table that holds a user id (from the catalog)', async () => {
        await seedUser(s, 'u');
        await seedUser(s, 'v');
        const g1 = await grant(s, 'u', 'c1');
        const rotated = await rotate(s, g1.refresh); // leaves a refresh tombstone with the user id
        expect(rotated).toBeDefined();
        await grant(s, 'u', 'c2');
        await spentCode(s, 'u', 'c1'); // an exchange in flight
        await s.saveAuthCode({
          code: `code-${randomUUID()}`,
          clientId: 'c1',
          userId: 'u',
          redirectUri: 'https://client.example/cb',
          codeChallenge: 'chal',
          scopes: [],
          expiresAt: Date.now() + 600_000,
        });
        const kept = await grant(s, 'v', 'c1');
        // A tombstone as 0.4.x wrote it (no user id), in one of u's families.
        if (h.sql) {
          await h.sql(
            `INSERT INTO consumed_refresh_tokens (token, client_id, family_id, expires_at) VALUES ($1, $2, $3, $4)`,
            ['legacy-tombstone', 'c1', g1.familyId, Date.now() + DAY]
          );
        }

        const before = await h.userRows('u');
        const expected =
          h.kind === 'memory'
            ? ['users', 'authCodes', 'accessTokens', 'refreshTokens', 'consumedRefreshTokens', 'consumedAuthCodes']
            : ['users', 'auth_codes', 'access_tokens', 'refresh_tokens', 'consumed_refresh_tokens', 'consumed_auth_codes'];
        for (const table of expected) expect(before[table], table).toBeGreaterThan(0);

        await s.deleteUserData('u');

        const after = await h.userRows('u');
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
        if (h.sql) {
          const rows = await h.sql('SELECT token FROM consumed_refresh_tokens WHERE token = $1', ['legacy-tombstone']);
          expect(rows).toEqual([]);
        }
        expect(await s.getUser('u')).toBeUndefined();
        expect(await s.getAccessToken(g1.access.token)).toBeUndefined();
        expect(await s.getRefreshToken((rotated as RefreshTokenRecord).token)).toBeUndefined();
        expect(await s.listConnections('u')).toEqual([]);

        // The other user is untouched.
        expect(await s.getUser('v')).toBeDefined();
        expect(await s.getAccessToken(kept.access.token)).toBeDefined();
        expect(await s.getRefreshToken(kept.refresh.token)).toBeDefined();
        expect((await h.userRows('v'))[h.kind === 'memory' ? 'consumedAuthCodes' : 'consumed_auth_codes']).toBe(1);
      });

      it('an exchange in flight is refused once the user is erased, even after they connect again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await seedUser(s, 'u');
        const { code, familyId } = await spentCode(s, 'u', 'c');
        await s.deleteUserData('u');
        vi.setSystemTime(Date.now() + 1000);
        await seedUser(s, 'u'); // re-consent
        const pair = { familyId, accessToken: accessToken('u', 'c', familyId), refreshToken: refreshToken('u', 'c', familyId) };
        expect(await s.saveCodeTokens(code, pair)).toBe(false);
        expect(await s.getAccessToken(pair.accessToken.token)).toBeUndefined();
        expect(await s.listConnections('u')).toEqual([]);
        // The new account works as usual.
        const fresh = await grant(s, 'u', 'c');
        expect(await s.getAccessToken(fresh.access.token)).toBeDefined();
      });

      // SQL only: memory has no 0.4.x rows (every tombstone carries its user).
      if (driver.kind !== 'memory')
        it(
        "reaches a 0.4.x refresh tombstone of a family that only the user's own tombstones still name",
        async () => {
          const sql = h.sql as NonNullable<DriverHandle['sql']>;
          await seedUser(s, 'u');
          const g = await grant(s, 'u', 'c');
          expect(await rotate(s, g.refresh)).toBeDefined(); // a 0.5.0 tombstone, with the user id
          await sql(
            'INSERT INTO consumed_refresh_tokens (token, client_id, family_id, expires_at) VALUES ($1, $2, $3, $4)',
            ['legacy-tombstone', 'c', g.familyId, Date.now() + DAY]
          );
          // The family's live tokens and its code tombstone are gone (expired, swept).
          await s.deleteTokenFamily(g.familyId);
          await sql('DELETE FROM consumed_auth_codes WHERE family_id = $1', [g.familyId]);

          await s.deleteUserData('u');
          expect(await sql('SELECT token FROM consumed_refresh_tokens')).toEqual([]);
        }
      );

      it('is a no-op for an unknown user', async () => {
        await expect(s.deleteUserData('nobody')).resolves.toBeUndefined();
      });
    });

    describe('account self-service', () => {
      it("revokeUserFamily: another user's family is a no-op, the same as an unknown one", async () => {
        await seedUser(s, 'u');
        await seedUser(s, 'v');
        const g = await grant(s, 'u', 'c');
        expect(await s.revokeUserFamily('v', g.familyId)).toBe(false);
        expect(await s.revokeUserFamily('u', randomUUID())).toBe(false);
        expect(await s.getAccessToken(g.access.token)).toBeDefined();
        expect(await s.getRefreshToken(g.refresh.token)).toBeDefined();

        expect(await s.revokeUserFamily('u', g.familyId)).toBe(true);
        expect(await s.getAccessToken(g.access.token)).toBeUndefined();
        expect(await s.getRefreshToken(g.refresh.token)).toBeUndefined();
        expect(await s.revokeUserFamily('u', g.familyId)).toBe(false);
      });

      it("revokeUserFamily refuses the family's exchange in flight", async () => {
        await seedUser(s, 'u');
        const { code, familyId } = await spentCode(s, 'u', 'c');
        expect(await s.revokeUserFamily('u', familyId)).toBe(true);
        const pair = { familyId, accessToken: accessToken('u', 'c', familyId), refreshToken: refreshToken('u', 'c', familyId) };
        expect(await s.saveCodeTokens(code, pair)).toBe(false);
      });

      it("deleteTokenFamiliesForClient revokes the user's grants to that client only", async () => {
        await seedUser(s, 'u');
        await seedUser(s, 'v');
        const a1 = await grant(s, 'u', 'A');
        const a2 = await grant(s, 'u', 'A');
        const b = await grant(s, 'u', 'B');
        const otherUser = await grant(s, 'v', 'A');
        const legacy = refreshToken('u', 'A'); // pre-0.4.0: no family
        await s.saveRefreshToken(legacy);

        expect(await s.deleteTokenFamiliesForClient('u', 'A')).toBe(3);
        for (const t of [a1.access, a2.access]) expect(await s.getAccessToken(t.token)).toBeUndefined();
        expect(await s.getRefreshToken(legacy.token)).toBeUndefined();
        expect(await s.getAccessToken(b.access.token)).toBeDefined();
        expect(await s.getAccessToken(otherUser.access.token)).toBeDefined();
        expect(await s.deleteTokenFamiliesForClient('u', 'A')).toBe(0);
      });

      it('listConnections lists the live grants of that user only, oldest first', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        await seedUser(s, 'u');
        await seedUser(s, 'v');
        await s.saveClient(client('A'));
        const first = await grant(s, 'u', 'A');
        vi.setSystemTime(t0 + 1000);
        const second = await grant(s, 'u', 'gone'); // a client with no row: no name
        await grant(s, 'v', 'A');
        await s.saveRefreshToken(refreshToken('u', 'A')); // no family: not listed

        expect(await s.listConnections('u')).toEqual([
          {
            familyId: first.familyId,
            clientId: 'A',
            clientName: 'App A',
            grantedScope: 'read-write',
            createdAt: t0,
            lastUsedAt: t0,
            expiresAt: t0 + IDLE,
          },
          {
            familyId: second.familyId,
            clientId: 'gone',
            clientName: undefined,
            grantedScope: 'read-write',
            createdAt: t0 + 1000,
            lastUsedAt: t0 + 1000,
            expiresAt: t0 + 1000 + IDLE,
          },
        ]);
        expect(await s.listConnections('nobody')).toEqual([]);
      });

      it('the AccountStore exposes only the user-scoped methods', async () => {
        await seedUser(s, 'u');
        const g = await grant(s, 'u', 'c');
        const account = createAccountStore(s);
        expect(Object.keys(account).sort()).toEqual([
          'deleteTokenFamiliesForClient',
          'deleteUserData',
          'listConnections',
          'revokeUserFamily',
        ]);
        expect('deleteTokenFamily' in account).toBe(false);
        expect(Object.isFrozen(account)).toBe(true);
        expect(await account.listConnections('u')).toHaveLength(1);
        expect(await account.revokeUserFamily('u', g.familyId)).toBe(true);
        await account.deleteUserData('u');
        expect(await s.getUser('u')).toBeUndefined();
      });
    });

    describe('sweepExpired', () => {
      it('deletes expired, orphaned and abandoned rows in batches, and keeps live ones', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const T = Date.now();

        vi.setSystemTime(T);
        await s.saveClient(client('live'));
        await seedUser(s, 'v');
        const live = await grant(s, 'v', 'live');
        const liveRefresh = await rotate(s, live.refresh, T - 1); // its tombstone is already expired
        expect(liveRefresh).toBeDefined();
        for (let i = 0; i < 3; i++) {
          await s.savePendingAuth({
            state: `expired-${i}`,
            clientId: 'live',
            redirectUri: 'https://client.example/cb',
            codeChallenge: 'chal',
            clientState: undefined,
            scopes: [],
            grantedScope: 'read-only',
            expiresAt: T - 1,
          });
        }
        await s.savePendingAuth({
          state: 'live-state',
          clientId: 'new',
          redirectUri: 'https://client.example/cb',
          codeChallenge: 'chal',
          clientState: undefined,
          scopes: [],
          grantedScope: 'read-only',
          expiresAt: T + 600_000,
        });
        for (let i = 0; i < 2; i++) {
          await s.saveAuthCode({
            code: `expired-code-${i}`,
            clientId: 'live',
            userId: 'v',
            redirectUri: 'https://client.example/cb',
            codeChallenge: 'chal',
            scopes: [],
            expiresAt: T - 1,
          });
        }
        await s.saveAccessToken(accessToken('v', 'live', live.familyId, -1)); // expired
        // 2 days ago: a registration that never completed authorization.
        vi.setSystemTime(T - 2 * DAY);
        await s.saveClient(client('abandoned'));
        // 1 hour ago: a registration still inside its 24 hours.
        vi.setSystemTime(T - 3_600_000);
        await s.saveClient(client('new'));
        // 100 days ago: a client that was authorized once; its grant has since
        // expired. Written last because spending a code prunes expired code
        // tombstones, and this one's must be left for the sweep.
        vi.setSystemTime(T - 100 * DAY);
        await s.saveClient(client('unused'));
        await seedUser(s, 'u');
        await grant(s, 'u', 'unused');

        vi.setSystemTime(T);
        // An erased user's leftovers (deleteUser removes the row only).
        await seedUser(s, 'w');
        await s.saveAccessToken(accessToken('w', 'live', undefined, 3_600_000));
        await s.saveRefreshToken(refreshToken('w', 'live'));
        await s.deleteUser('w');

        const result = await s.sweepExpired({ batchSize: 2 });
        expect(result).toEqual({
          ran: true,
          deleted: {
            pendingAuth: 3,
            authCodes: 2,
            accessTokens: 2, // u's (expired with its grant) and v's expired one
            refreshTokens: 1, // u's, past both limits
            consumedRefreshTokens: 1,
            consumedAuthCodes: 1, // u's code tombstone
            orphanTokens: 2,
            abandonedClients: 1,
            unusedClients: 1,
          },
        });

        expect(await s.getClient('unused')).toBeUndefined();
        expect(await s.getClient('abandoned')).toBeUndefined();
        expect(await s.getClient('new')).toBeDefined();
        expect(await s.getClient('live')).toBeDefined();
        expect(await s.getRefreshToken((liveRefresh as RefreshTokenRecord).token)).toBeDefined();

        const again = await s.sweepExpired();
        expect(again.ran).toBe(true);
        expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
        expect(await s.takePendingAuth('live-state')).toBeDefined();
      });

      it('keeps a client whose authorization is completing: a spent code awaiting its exchange, or a YNAB exchange in flight', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const T = Date.now();
        const pending = (state: string, clientId: string) => ({
          state,
          clientId,
          redirectUri: 'https://client.example/cb',
          codeChallenge: 'chal',
          clientState: undefined,
          scopes: [],
          grantedScope: 'read-only' as const,
          expiresAt: Date.now() + 600_000,
        });
        // Registered 2 days ago and never authorized: abandoned unless in flight.
        vi.setSystemTime(T - 2 * DAY);
        await s.saveClient(client('mid-exchange'));
        await s.saveClient(client('at-callback'));
        // Authorized 100 days ago (that grant has expired), now authorizing again.
        vi.setSystemTime(T - 100 * DAY);
        await s.saveClient(client('returning'));
        await seedUser(s, 'u');
        await grant(s, 'u', 'returning');

        vi.setSystemTime(T);
        // Between consumeAuthCode and saveCodeTokens: only the code's tombstone.
        const { code, familyId } = await spentCode(s, 'u', 'mid-exchange');
        // Between takePendingAuth and saveAuthCode (the YNAB code exchange): no row at all.
        await s.savePendingAuth(pending('state-1', 'at-callback'));
        expect(await s.takePendingAuth('state-1')).toBeDefined();
        await s.savePendingAuth(pending('state-2', 'returning'));
        expect(await s.takePendingAuth('state-2')).toBeDefined();

        const during = await s.sweepExpired();
        expect(during.deleted).toMatchObject({ abandonedClients: 0, unusedClients: 0 });
        for (const id of ['mid-exchange', 'at-callback', 'returning']) expect(await s.getClient(id), id).toBeDefined();
        const pair = { familyId, accessToken: accessToken('u', 'mid-exchange', familyId), refreshToken: refreshToken('u', 'mid-exchange', familyId) };
        expect(await s.saveCodeTokens(code, pair)).toBe(true);

        // A day later, a callback that never produced a code no longer protects its client.
        vi.setSystemTime(T + DAY + 1);
        const later = await s.sweepExpired();
        expect(later.deleted).toMatchObject({ abandonedClients: 1, unusedClients: 1 });
        expect(await s.getClient('at-callback')).toBeUndefined();
        expect(await s.getClient('returning')).toBeUndefined();
        expect(await s.getClient('mid-exchange')).toBeDefined(); // authorized, with a live grant
      });

      it('uses the configured windows', async () => {
        await open({ retention: { abandonedClientMs: HOUR, unusedClientMs: 5000 } });
        vi.useFakeTimers({ toFake: ['Date'] });
        const T = Date.now();
        await s.saveClient(client('a'));
        expect((await s.sweepExpired({ now: T + HOUR })).deleted.abandonedClients).toBe(0);
        expect((await s.sweepExpired({ now: T + HOUR + 1 })).deleted.abandonedClients).toBe(1);
      });
    });
  });
}

describe('retentionPolicy', () => {
  it('defaults to 30 days idle, 90 days absolute, 24 hours and 90 days for clients', () => {
    expect(retentionPolicy()).toEqual({
      refreshTokenIdleMs: 30 * DAY,
      refreshTokenTtlMs: 90 * DAY,
      abandonedClientMs: DAY,
      unusedClientMs: 90 * DAY,
    });
  });

  it('refuses a window that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => retentionPolicy({ refreshTokenIdleMs: bad })).toThrow(/positive integer/);
    }
  });

  it('refuses an abandoned-registration window under one hour', () => {
    // last_seen_at protects a client mid-callback only for this window (the YNAB exchange has no deadline).
    expect(() => retentionPolicy({ abandonedClientMs: HOUR - 1 })).toThrow(/at least 3600000 ms/);
    expect(retentionPolicy({ abandonedClientMs: HOUR }).abandonedClientMs).toBe(HOUR);
  });
});

// --- Postgres: two pools racing the erase (G11), and the sweep lock (G12) ---

const pgDriver = testDrivers.find((d) => d.kind === 'postgres');

describe.skipIf(!pgDriver?.enabled)('STOR-1 on Postgres: races on two pools', () => {
  /** A second replica on the same schema, named so pg_stat_activity can find its waits. */
  async function replica(h: DriverHandle): Promise<{ storage: Storage; app: string }> {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const app = `stor1-${randomUUID().slice(0, 8)}`;
    const url = new URL(h.connectionString as string);
    url.searchParams.set('application_name', app);
    const storage = new PostgresStorage({ connectionString: url.toString(), tokenKeys: TEST_TOKEN_HASHER });
    await storage.init();
    return { storage, app };
  }

  /** Tracks whether a promise has settled yet. */
  function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
    let done = false;
    const promise = p.finally(() => {
      done = true;
    });
    return { promise, settled: () => done };
  }

  /** Waits until a connection of `app` is blocked on a lock (fails if `p` settles first). */
  async function blocked(h: DriverHandle, app: string, p: { settled: () => boolean }): Promise<void> {
    const sql = h.sql as NonNullable<DriverHandle['sql']>;
    for (;;) {
      if (p.settled()) throw new Error('the operation did not wait for the lock');
      const rows = await sql(
        `SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [app]
      );
      if (rows.length > 0) return;
    }
  }

  /** A raw transaction on its own connection. */
  async function rawTx(h: DriverHandle) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: h.connectionString });
    const tx = await pool.connect();
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout = '10s'");
    let ended = false;
    return {
      query: (text: string, params?: unknown[]) => tx.query(text, params),
      async end(commit: boolean) {
        if (ended) return;
        ended = true;
        await tx.query(commit ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
        tx.release();
        await pool.end();
      },
    };
  }

  /** The parts of deleteUserData after the user row, by hand. */
  async function eraseRest(tx: Awaited<ReturnType<typeof rawTx>>, userId: string): Promise<void> {
    for (const table of ['auth_codes', 'access_tokens', 'refresh_tokens', 'consumed_auth_codes', 'consumed_refresh_tokens']) {
      await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }
  }

  let h: DriverHandle;
  let other: { storage: Storage; app: string };
  beforeEach(async () => {
    h = await (pgDriver as NonNullable<typeof pgDriver>).open();
    other = await replica(h);
  });
  afterEach(async () => {
    await other.storage.close();
  });

  it('a code exchange in flight waits for the erase holding the user row, then saves nothing', async () => {
    await seedUser(h.storage, 'u');
    const { code, familyId } = await spentCode(h.storage, 'u', 'c');
    const tx = await rawTx(h);
    try {
      await tx.query('DELETE FROM users WHERE user_id = $1', ['u']);
      const pair = { familyId, accessToken: accessToken('u', 'c', familyId), refreshToken: refreshToken('u', 'c', familyId) };
      const save = track(other.storage.saveCodeTokens(code, pair));
      await blocked(h, other.app, save);
      await eraseRest(tx, 'u');
      await tx.end(true);
      expect(await save.promise).toBe(false);
      expect(Object.values(await h.userRows('u')).every((n) => n === 0)).toBe(true);
    } finally {
      await tx.end(false);
    }
  });

  it("a rotation in flight (a 0.3.x token, whose new family no erase could lock) waits for the erase, then mints nothing", async () => {
    await seedUser(h.storage, 'u');
    const legacy = refreshToken('u', 'c'); // no family
    await h.storage.saveRefreshToken(legacy);
    const tx = await rawTx(h);
    try {
      await tx.query('DELETE FROM users WHERE user_id = $1', ['u']);
      const familyId = randomUUID();
      const next = refreshToken('u', 'c', familyId);
      const rotation = track(
        other.storage.rotateRefreshToken(legacy.token, {
          familyId,
          consumedUntil: Date.now() + DAY,
          accessToken: accessToken('u', 'c', familyId),
          refreshToken: next,
        })
      );
      await blocked(h, other.app, rotation);
      await eraseRest(tx, 'u');
      await tx.end(true);
      expect(await rotation.promise).toBeUndefined();
      expect(Object.values(await h.userRows('u')).every((n) => n === 0)).toBe(true);
    } finally {
      await tx.end(false);
    }
  });

  it('the erase waits for a rotation holding the user row, then deletes the pair it saved', async () => {
    const { LOCK_FAMILY } = await import('../../../src/storage/postgres.js');
    await seedUser(h.storage, 'u');
    const legacy = refreshToken('u', 'c');
    await h.storage.saveRefreshToken(legacy);
    const tx = await rawTx(h);
    try {
      // A rotation by hand, as rotateRefreshToken runs it, left uncommitted.
      const familyId = randomUUID();
      await tx.query(LOCK_FAMILY, [familyId]);
      await tx.query('SELECT 1 FROM users WHERE user_id = $1 FOR KEY SHARE', ['u']);
      await tx.query('DELETE FROM refresh_tokens WHERE token = $1', [legacy.token]);
      await tx.query(
        `INSERT INTO refresh_tokens (token, client_id, user_id, scopes, family_id, issued_at, family_created_at)
         VALUES ($1, 'c', 'u', '[]', $2, $3, $3)`,
        [`rt-${randomUUID()}`, familyId, Date.now()]
      );
      await tx.query(
        `INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, family_id, issued_at)
         VALUES ($1, 'c', 'u', '[]', $2, $3, $4)`,
        [`at-${randomUUID()}`, Date.now() + 60_000, familyId, Date.now()]
      );
      const erase = track(other.storage.deleteUserData('u'));
      await blocked(h, other.app, erase);
      await tx.end(true);
      await erase.promise;
      expect(Object.values(await h.userRows('u')).every((n) => n === 0)).toBe(true);
    } finally {
      await tx.end(false);
    }
  });

  it('a YNAB write-back racing the erase finds no row and inserts none', async () => {
    await seedUser(h.storage, 'u', 'old');
    const tx = await rawTx(h);
    try {
      await tx.query('DELETE FROM users WHERE user_id = $1', ['u']);
      const write = track(other.storage.updateUserRefreshToken('u', 'old', 'new'));
      await blocked(h, other.app, write);
      await tx.end(true);
      expect(await write.promise).toBeUndefined();
      expect(await h.storage.getUser('u')).toBeUndefined();
    } finally {
      await tx.end(false);
    }
  });

  it('of two sweepers, one runs and the other skips', async () => {
    const { SWEEP_LOCK_KEY } = await import('../../../src/storage/postgres.js');
    const pg = (await import('pg')).default;
    const holder = new pg.Client({ connectionString: h.connectionString });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SWEEP_LOCK_KEY]);
      expect(await other.storage.sweepExpired()).toMatchObject({ ran: false });
      await holder.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
      expect(await other.storage.sweepExpired()).toMatchObject({ ran: true });
      // Concurrent sweeps never fail; at least one runs.
      const both = await Promise.all([h.storage.sweepExpired(), other.storage.sweepExpired()]);
      expect(both.some((r) => r.ran)).toBe(true);
    } finally {
      await holder.end();
    }
  });
});

// --- M2 from an M1 database (G7), on SQLite and Postgres ---

const M2_COLUMNS = new Set([
  'users.created_at',
  'access_tokens.issued_at',
  'refresh_tokens.issued_at',
  'refresh_tokens.family_created_at',
  'consumed_refresh_tokens.user_id',
  'oauth_clients.created_at',
  'oauth_clients.last_authorized_at',
  'oauth_clients.last_seen_at',
]);
const M2_INDEXES = new Set([
  'access_tokens_user_id',
  'refresh_tokens_user_id',
  'auth_codes_user_id',
  'consumed_refresh_tokens_user_id',
  'access_tokens_expires_at',
  'auth_codes_expires_at',
  'pending_auth_expires_at',
  'refresh_tokens_issued_at',
  'refresh_tokens_family_created_at',
]);

/** The plan as it stood at M1 (schema version 2). */
const M1_PLAN: MigrationPlan = {
  tables: ADDED_TABLES,
  columns: ADDED_COLUMNS.filter((c) => !M2_COLUMNS.has(`${c.table}.${c.column}`)),
  indexes: ADDED_INDEXES.filter((i) => !M2_INDEXES.has(i.name)),
  backfills: [],
  schemaVersion: 2,
  release: '0.5.0',
  minCompatibleRelease: '0.5.0',
};

/** The base (0.3.x + 0.4.0 tombstone) tables every driver creates before the migrations. */
function baseSchema(int: 'INTEGER' | 'BIGINT'): string[] {
  return [
    `CREATE TABLE users (user_id TEXT PRIMARY KEY, granted_scope TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL, updated_at ${int} NOT NULL)`,
    'CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_json TEXT NOT NULL)',
    `CREATE TABLE pending_auth (state TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, client_state TEXT, scopes TEXT NOT NULL, granted_scope TEXT NOT NULL, expires_at ${int} NOT NULL)`,
    `CREATE TABLE auth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scopes TEXT NOT NULL, expires_at ${int} NOT NULL)`,
    `CREATE TABLE access_tokens (token TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, expires_at ${int} NOT NULL)`,
    'CREATE TABLE refresh_tokens (token TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL)',
    `CREATE TABLE consumed_refresh_tokens (token TEXT PRIMARY KEY, client_id TEXT NOT NULL, family_id TEXT NOT NULL, expires_at ${int} NOT NULL)`,
  ];
}

/** Rows as an M1 release wrote them. */
function m1Rows(farFuture: number): Array<[string, unknown[]]> {
  return [
    ["INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at) VALUES ('m1-user', 'read-write', 'enc', 1)", []],
    [`INSERT INTO oauth_clients (client_id, client_json) VALUES ('m1-client', '{"client_id":"m1-client","client_name":"M1"}')`, []],
    [`INSERT INTO oauth_clients (client_id, client_json) VALUES ('m1-idle', '{"client_id":"m1-idle"}')`, []],
    [
      `INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, granted_scope, family_id) VALUES ('m1-at', 'm1-client', 'm1-user', '[]', $1, 'read-write', 'm1-family')`,
      [farFuture],
    ],
    [
      `INSERT INTO refresh_tokens (token, client_id, user_id, scopes, granted_scope, family_id) VALUES ('m1-rt', 'm1-client', 'm1-user', '[]', 'read-write', 'm1-family')`,
      [],
    ],
    [
      `INSERT INTO consumed_refresh_tokens (token, client_id, family_id, expires_at) VALUES ('m1-spent', 'm1-client', 'm1-family', $1)`,
      [farFuture],
    ],
  ];
}

interface RawMigrationDb {
  tx(): Promise<{ tx: MigrationTx; commit: () => Promise<void> }>;
  sql(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  open(): Promise<Storage>;
  columns(): Promise<Set<string>>;
  indexes(): Promise<Set<string>>;
  cleanup(): Promise<void>;
}

async function sqliteRaw(): Promise<RawMigrationDb> {
  const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmSync } = await import('node:fs');
  const file = join(tmpdir(), `ynab-mcp-m1-${randomUUID()}.db`);
  const q = (t: string) => t.replace(/\$\d+/g, '?');
  const sql = async (text: string, params: unknown[] = []) => {
    const db = new Database(file);
    try {
      const stmt = db.prepare(q(text));
      return stmt.reader ? (stmt.all(...params) as Array<Record<string, unknown>>) : (stmt.run(...params), []);
    } finally {
      db.close();
    }
  };
  const opened: Storage[] = [];
  return {
    async tx() {
      const db = new Database(file);
      db.exec('BEGIN IMMEDIATE');
      return {
        tx: {
          dialect: 'sqlite',
          async exec(text, params = []) {
            if (params.length === 0) db.exec(text);
            else db.prepare(q(text)).run(...params);
          },
          async query<T extends object>(text: string, params: readonly unknown[] = []) {
            return db.prepare(q(text)).all(...params) as T[];
          },
          async addColumnIfMissing(table, column, type) {
            const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
            if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
          },
        },
        async commit() {
          db.exec('COMMIT');
          db.close();
        },
      };
    },
    sql,
    async open() {
      const s = new SqliteStorage({ path: file, tokenKeys: TEST_TOKEN_HASHER });
      await s.init();
      opened.push(s);
      return s;
    },
    async columns() {
      const out = new Set<string>();
      for (const { name } of await sql("SELECT name FROM sqlite_master WHERE type = 'table'")) {
        for (const c of await sql(`PRAGMA table_info(${String(name)})`)) out.add(`${String(name)}.${String(c['name'])}`);
      }
      return out;
    },
    async indexes() {
      return new Set((await sql("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => String(r['name'])));
    },
    async cleanup() {
      for (const s of opened) await s.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    },
  };
}

async function postgresRaw(): Promise<RawMigrationDb> {
  const { PostgresStorage } = await import('../../../src/storage/postgres.js');
  const pg = (await import('pg')).default;
  const base = process.env.DATABASE_URL as string;
  const schema = `m1_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  const opened: Storage[] = [];
  const sql = async (text: string, params: unknown[] = []) =>
    (await pool.query(text, params)).rows as Array<Record<string, unknown>>;
  return {
    async tx() {
      const c = await pool.connect();
      await c.query('BEGIN');
      return {
        tx: {
          dialect: 'postgres',
          async exec(text, params) {
            await c.query(text, params ? [...params] : undefined);
          },
          async query<T extends object>(text: string, params?: readonly unknown[]) {
            return (await c.query(text, params ? [...params] : undefined)).rows as T[];
          },
          async addColumnIfMissing(table, column, type) {
            await c.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
          },
        },
        async commit() {
          await c.query('COMMIT');
          c.release();
        },
      };
    },
    sql,
    async open() {
      const s = new PostgresStorage({ connectionString: url.toString(), tokenKeys: TEST_TOKEN_HASHER });
      await s.init();
      opened.push(s);
      return s;
    },
    async columns() {
      const rows = await sql(
        'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1',
        [schema]
      );
      return new Set(rows.map((r) => `${String(r['table_name'])}.${String(r['column_name'])}`));
    },
    async indexes() {
      const rows = await sql('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [schema]);
      return new Set(rows.map((r) => String(r['indexname'])));
    },
    async cleanup() {
      for (const s of opened) await s.close();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    },
  };
}

const sqlDrivers = [
  { name: 'SqliteStorage', enabled: testDrivers.find((d) => d.kind === 'sqlite')?.enabled ?? false, raw: sqliteRaw },
  { name: 'PostgresStorage', enabled: pgDriver?.enabled ?? false, raw: postgresRaw },
];

for (const { name, enabled, raw: makeRaw } of sqlDrivers) {
  describe.skipIf(!enabled)(`M2 migration from an M1 database: ${name}`, () => {
    let raw: RawMigrationDb;
    beforeEach(async () => {
      raw = await makeRaw();
      const int = name === 'SqliteStorage' ? 'INTEGER' : 'BIGINT';
      const { tx, commit } = await raw.tx();
      for (const stmt of baseSchema(int)) await tx.exec(stmt);
      await applyMigrations(tx, 1, M1_PLAN);
      await commit();
      for (const [text, params] of m1Rows(Date.now() + 365 * DAY)) await raw.sql(text, params);
    });
    afterEach(async () => {
      await raw.cleanup();
    });

    /** Opens with a clock that moves on every read, as if each backfill statement ran later. */
    async function openWithAdvancingClock(start: number): Promise<Storage> {
      let t = start;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
      try {
        return await raw.open();
      } finally {
        spy.mockRestore();
      }
    }

    async function clocks(): Promise<Record<string, unknown>> {
      const one = async (text: string) => (await raw.sql(text))[0]?.['v'] ?? null;
      const num = (v: unknown) => (v === null ? null : Number(v));
      return {
        atIssued: num(await one("SELECT issued_at AS v FROM access_tokens WHERE token = 'm1-at'")),
        rtIssued: num(await one("SELECT issued_at AS v FROM refresh_tokens WHERE token = 'm1-rt'")),
        rtFamily: num(await one("SELECT family_created_at AS v FROM refresh_tokens WHERE token = 'm1-rt'")),
        clientCreated: num(await one("SELECT created_at AS v FROM oauth_clients WHERE client_id = 'm1-client'")),
        clientAuthorized: num(await one("SELECT last_authorized_at AS v FROM oauth_clients WHERE client_id = 'm1-client'")),
        idleCreated: num(await one("SELECT created_at AS v FROM oauth_clients WHERE client_id = 'm1-idle'")),
        idleAuthorized: num(await one("SELECT last_authorized_at AS v FROM oauth_clients WHERE client_id = 'm1-idle'")),
        userCreated: num(await one("SELECT created_at AS v FROM users WHERE user_id = 'm1-user'")),
      };
    }

    it('adds the M2 columns and indexes and stamps the current schema version', async () => {
      const before = await raw.columns();
      for (const c of M2_COLUMNS) expect(before.has(c), c).toBe(false);
      await (await raw.open()).close();
      const cols = await raw.columns();
      for (const c of M2_COLUMNS) expect(cols.has(c), c).toBe(true);
      const idx = await raw.indexes();
      for (const i of M2_INDEXES) expect(idx.has(i), i).toBe(true);
      expect((await raw.sql("SELECT value FROM schema_meta WHERE key = 'schema_version'"))[0]?.['value']).toBe(
        String(SCHEMA_VERSION)
      );
    });

    it('backfills one instant even when the clock moves between statements, leaves users.created_at NULL, and logs nobody out', async () => {
      const T0 = Date.now() + DAY;
      const s = await openWithAdvancingClock(T0);
      const c = await clocks();
      const T = c['atIssued'];
      expect(T).toBe(T0 + 1000); // captured once, at the first read under the lock
      expect(c).toEqual({
        atIssued: T,
        rtIssued: T,
        rtFamily: T,
        clientCreated: T,
        clientAuthorized: T, // it holds a refresh token, so it has authorized
        idleCreated: T,
        idleAuthorized: null, // never authorized: the 24-hour rule applies from T
        userCreated: null,
      });
      expect(await s.getAccessToken('m1-at')).toBeDefined();
      expect(await s.getRefreshToken('m1-rt')).toBeDefined();
      expect((await s.getUser('m1-user'))?.createdAt).toBeUndefined();
      expect(await s.listConnections('m1-user')).toHaveLength(1);

      // A restart re-runs the backfill: nothing changes.
      await openWithAdvancingClock(T0 + 50 * DAY);
      expect(await clocks()).toEqual(c);
    });

    it('stamps a row written later by a 0.4.x replica at the next startup, and the old rows keep theirs', async () => {
      const s = await openWithAdvancingClock(Date.now());
      const T = (await clocks())['rtIssued'];
      await raw.sql(
        `INSERT INTO refresh_tokens (token, client_id, user_id, scopes, granted_scope, family_id) VALUES ('replica-rt', 'm1-client', 'm1-user', '[]', 'read-write', 'replica-family')`
      );
      // Unstamped, it has no limit yet and still works.
      expect(await s.getRefreshToken('replica-rt')).toBeDefined();
      const T2 = Date.now() + 2 * DAY;
      await openWithAdvancingClock(T2);
      const rows = await raw.sql("SELECT token, issued_at, family_created_at FROM refresh_tokens ORDER BY token");
      expect(rows.map((r) => [r['token'], Number(r['issued_at']), Number(r['family_created_at'])])).toEqual([
        ['m1-rt', T, T],
        ['replica-rt', T2 + 1000, T2 + 1000],
      ]);
    });

    it('a backfilled refresh token expires 30 days idle after the upgrade', async () => {
      const s = await openWithAdvancingClock(Date.now());
      const T = Number((await clocks())['rtIssued']);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T + IDLE);
      expect(await s.getRefreshToken('m1-rt')).toBeDefined();
      vi.setSystemTime(T + IDLE + 1);
      expect(await s.getRefreshToken('m1-rt')).toBeUndefined();
    });

    it('deleteUserData reaches a pre-M2 tombstone (no user id) through its family', async () => {
      const s = await raw.open();
      await s.deleteUserData('m1-user');
      expect(await raw.sql("SELECT token FROM consumed_refresh_tokens")).toEqual([]);
      expect(await raw.sql("SELECT token FROM refresh_tokens")).toEqual([]);
    });
  });
}

// --- completeAuthorization (#94): the user and the code in one transaction ---

function authCode(clientId: string, userId: string, code = `code-${randomUUID()}`) {
  return {
    code,
    clientId,
    userId,
    redirectUri: 'https://client.example/cb',
    codeChallenge: 'chal',
    scopes: ['ynab'],
    expiresAt: Date.now() + 600_000,
    grantedScope: 'read-write' as const,
  };
}

function consentFor(userId: string, token: string, grantedScope: 'read-only' | 'read-write' = 'read-write') {
  return { userId, grantedScope, encryptedRefreshToken: token, updatedAt: Date.now() };
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`completeAuthorization (#94): ${driver.name}`, () => {
    let h: DriverHandle;
    let s: Storage;
    beforeEach(async () => {
      h = await driver.open();
      s = h.storage;
    });

    it('writes the user and the code, and the code redeems', async () => {
      await s.saveClient(client('c'));
      const code = authCode('c', 'u');
      expect(await s.completeAuthorization({ user: consentFor('u', 'enc-new'), code })).toBe(true);
      expect(await s.getUser('u')).toMatchObject({ encryptedRefreshToken: 'enc-new', grantedScope: 'read-write' });
      const consumed = await s.consumeAuthCode(code.code, { familyId: randomUUID(), consumedUntil: Date.now() + 600_000 });
      expect(consumed).toMatchObject({ clientId: 'c', userId: 'u', grantedScope: 'read-write' });
    });

    it('keeps the account generation when the user already exists', async () => {
      await s.saveClient(client('c'));
      await seedUser(s, 'u', 'enc-old');
      const before = await s.getUser('u');
      expect(await s.completeAuthorization({ user: consentFor('u', 'enc-new'), code: authCode('c', 'u') })).toBe(true);
      const after = await s.getUser('u');
      expect(after?.encryptedRefreshToken).toBe('enc-new');
      expect(after?.createdAt).toBe(before?.createdAt);
    });

    it('a client deleted before completion: false, no user and no code', async () => {
      const code = authCode('gone', 'u');
      expect(await s.completeAuthorization({ user: consentFor('u', 'enc-new'), code })).toBe(false);
      expect(await s.getUser('u')).toBeUndefined();
      expect(await s.takeAuthCode(code.code)).toBeUndefined();
      expect(Object.values(await h.userRows('u')).every((n) => n === 0)).toBe(true);
    });

    it('a client removed by the sweep: false, and an existing user is unchanged', async () => {
      await s.saveClient(client('c'));
      await seedUser(s, 'u', 'enc-old');
      const before = await s.getUser('u');
      expect((await s.sweepExpired({ now: Date.now() + 400 * DAY })).deleted.abandonedClients).toBe(1);
      const code = authCode('c', 'u');
      expect(await s.completeAuthorization({ user: consentFor('u', 'enc-new', 'read-only'), code })).toBe(false);
      expect(await s.getUser('u')).toEqual(before);
      expect(await s.takeAuthCode(code.code)).toBeUndefined();
    });

    // Memory overwrites a duplicate code, so only the SQL drivers can fail the second write.
    if (driver.kind !== 'memory') {
      it('a write that fails leaves the user unchanged', async () => {
        await s.saveClient(client('c'));
        expect(await s.completeAuthorization({ user: consentFor('u', 'enc-mid'), code: authCode('c', 'u', 'dup') })).toBe(true);
        // The same code again violates its primary key; the user write rolls back with it.
        await expect(
          s.completeAuthorization({ user: consentFor('u', 'enc-second'), code: authCode('c', 'u', 'dup') })
        ).rejects.toThrow();
        expect((await s.getUser('u'))?.encryptedRefreshToken).toBe('enc-mid');
      });
    }
  });
}

describe.skipIf(!pgDriver?.enabled)('completeAuthorization (#94) on Postgres: a sweep racing it', () => {
  type PgPool = import('pg').Pool;
  type PgClient = import('pg').PoolClient;

  async function replica(h: DriverHandle): Promise<{ storage: Storage; app: string }> {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const app = `auth94-${randomUUID().slice(0, 8)}`;
    const url = new URL(h.connectionString as string);
    url.searchParams.set('application_name', app);
    const storage = new PostgresStorage({ connectionString: url.toString(), tokenKeys: TEST_TOKEN_HASHER });
    await storage.init();
    return { storage, app };
  }

  function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
    let done = false;
    const promise = p.finally(() => {
      done = true;
    });
    return { promise, settled: () => done };
  }

  async function blocked(h: DriverHandle, app: string, p: { settled: () => boolean }): Promise<void> {
    const sql = h.sql as NonNullable<DriverHandle['sql']>;
    for (;;) {
      if (p.settled()) throw new Error('the operation did not wait for the lock');
      const rows = await sql(
        `SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [app]
      );
      if (rows.length > 0) return;
    }
  }

  /**
   * Holds `storage`'s transactions open right after their `UPDATE oauth_clients`
   * (the completion's client check) until `release()`. `reached` resolves once a
   * transaction is held there.
   */
  function holdAfterClientUpdate(storage: Storage): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reachedResolve!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    const pool = (storage as unknown as { pool: PgPool }).pool;
    const connect = pool.connect.bind(pool) as () => Promise<PgClient>;
    (pool as unknown as { connect: () => Promise<PgClient> }).connect = async () => {
      const c = await connect();
      const query = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
      (c as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args) => {
        const result = await query(...args);
        if (typeof args[0] === 'string' && args[0].includes('UPDATE oauth_clients')) {
          reachedResolve();
          await gate;
        }
        return result;
      };
      return c;
    };
    return { reached, release };
  }

  let h: DriverHandle;
  let other: { storage: Storage; app: string };
  beforeEach(async () => {
    h = await (pgDriver as NonNullable<typeof pgDriver>).open();
    other = await replica(h);
    // A registration the sweep would delete right now: old, never authorized, not seen.
    await h.storage.saveClient(client('c'));
    await (h.sql as NonNullable<DriverHandle['sql']>)(
      'UPDATE oauth_clients SET created_at = 0, last_seen_at = NULL WHERE client_id = $1',
      ['c']
    );
  });
  afterEach(async () => {
    await other.storage.close();
  });

  it('a sweep during the completion skips the client, and the sign-in completes', async () => {
    await seedUser(h.storage, 'u', 'enc-old');
    const hold = holdAfterClientUpdate(other.storage);
    const code = authCode('c', 'u');
    const completion = track(other.storage.completeAuthorization({ user: consentFor('u', 'enc-new'), code }));
    await hold.reached;
    try {
      // The sweep would delete 'c' (nothing but the stamp protects it), but the row is locked.
      const swept = await h.storage.sweepExpired();
      expect(swept.deleted).toMatchObject({ abandonedClients: 0, unusedClients: 0 });
    } finally {
      hold.release();
    }
    expect(await completion.promise).toBe(true);
    expect(await h.storage.getClient('c')).toBeDefined();
    expect((await h.storage.getUser('u'))?.encryptedRefreshToken).toBe('enc-new');
    expect(
      await h.storage.consumeAuthCode(code.code, { familyId: randomUUID(), consumedUntil: Date.now() + 600_000 })
    ).toBeDefined();
  });

  it('a sweep that holds the client first wins: the completion waits, returns false and writes nothing', async () => {
    await seedUser(h.storage, 'u', 'enc-old');
    const before = await h.storage.getUser('u');
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: h.connectionString });
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SET LOCAL lock_timeout = '10s'");
      await tx.query('DELETE FROM oauth_clients WHERE client_id = $1', ['c']);
      const code = authCode('c', 'u');
      const completion = track(other.storage.completeAuthorization({ user: consentFor('u', 'enc-new', 'read-only'), code }));
      await blocked(h, other.app, completion);
      await tx.query('COMMIT');
      expect(await completion.promise).toBe(false);
      expect(await h.storage.getClient('c')).toBeUndefined();
      expect(await h.storage.getUser('u')).toEqual(before);
      expect(await h.storage.takeAuthCode(code.code)).toBeUndefined();
    } finally {
      await tx.query('ROLLBACK').catch(() => undefined);
      tx.release();
      await pool.end();
    }
  });

  it('a sweep that commits before the completion starts: false, and nothing is written', async () => {
    const swept = await h.storage.sweepExpired();
    expect(swept.deleted.abandonedClients).toBe(1);
    const code = authCode('c', 'u');
    expect(await other.storage.completeAuthorization({ user: consentFor('u', 'enc-new'), code })).toBe(false);
    expect(await h.storage.getUser('u')).toBeUndefined();
    expect(await h.storage.takeAuthCode(code.code)).toBeUndefined();
  });
});
