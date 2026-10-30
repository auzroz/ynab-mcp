/**
 * Shared conformance suite for the Storage interface.
 *
 * The `runStorageConformance` function is parameterized by a Storage factory and
 * run against every durable and in-memory adapter, so all drivers are held to
 * identical semantics: user CRUD, client persistence, one-time take semantics for
 * pending-auth / auth-codes / refresh-tokens, access-token expiry, and
 * refresh-token rotation with tombstones and family revocation.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  Storage,
  UserRecord,
  AuthCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  RefreshTokenRotation,
  PendingAuthRecord,
} from '../../../src/storage/types.js';
import { MemoryStorage } from '../../../src/storage/memory.js';

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: `user-${randomUUID()}`,
    grantedScope: 'read-write',
    encryptedRefreshToken: 'enc-refresh-token',
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeClient(overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
  return {
    client_id: `client-${randomUUID()}`,
    client_name: 'Test Client',
    redirect_uris: ['https://example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    ...overrides,
  } as OAuthClientInformationFull;
}

function makePending(overrides: Partial<PendingAuthRecord> = {}): PendingAuthRecord {
  return {
    state: `state-${randomUUID()}`,
    clientId: 'client-1',
    redirectUri: 'https://example.com/callback',
    codeChallenge: 'challenge',
    clientState: 'client-echo-state',
    scopes: ['read', 'write'],
    grantedScope: 'read-write',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function makeAuthCode(overrides: Partial<AuthCodeRecord> = {}): AuthCodeRecord {
  return {
    code: `code-${randomUUID()}`,
    clientId: 'client-1',
    userId: 'user-1',
    redirectUri: 'https://example.com/callback',
    codeChallenge: 'challenge',
    scopes: ['read'],
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function makeAccessToken(overrides: Partial<AccessTokenRecord> = {}): AccessTokenRecord {
  return {
    token: `at-${randomUUID()}`,
    clientId: 'client-1',
    userId: 'user-1',
    scopes: ['read', 'write'],
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function makeRefreshToken(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    token: `rt-${randomUUID()}`,
    clientId: 'client-1',
    userId: 'user-1',
    scopes: ['read', 'write'],
    ...overrides,
  };
}

/** A rotation into a fresh pair of `familyId`, its tombstone kept for a day. */
function makeRotation(familyId: string, overrides: Partial<RefreshTokenRotation> = {}): RefreshTokenRotation {
  return {
    familyId,
    consumedUntil: Date.now() + 86_400_000,
    accessToken: makeAccessToken({ familyId }),
    refreshToken: makeRefreshToken({ familyId }),
    ...overrides,
  };
}

export function runStorageConformance(name: string, factory: () => Promise<Storage>): void {
  describe(`Storage conformance: ${name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await factory();
    });

    afterAll(async () => {
      await storage.close();
    });

    describe('users', () => {
      it('upserts, gets, updates, and deletes a user', async () => {
        const user = makeUser();
        await storage.upsertUser(user);

        const fetched = await storage.getUser(user.userId);
        expect(fetched).toEqual(user);

        const updated = makeUser({
          userId: user.userId,
          grantedScope: 'read-only',
          encryptedRefreshToken: 'new-token',
          updatedAt: user.updatedAt + 1000,
        });
        await storage.upsertUser(updated);
        expect(await storage.getUser(user.userId)).toEqual(updated);

        await storage.deleteUser(user.userId);
        expect(await storage.getUser(user.userId)).toBeUndefined();
      });

      it('returns undefined for an unknown user', async () => {
        expect(await storage.getUser('nope')).toBeUndefined();
      });
    });

    describe('clients', () => {
      it('saves and retrieves a client object faithfully', async () => {
        const client = makeClient();
        await storage.saveClient(client);
        expect(await storage.getClient(client.client_id)).toEqual(client);
      });

      it('returns undefined for an unknown client', async () => {
        expect(await storage.getClient('nope')).toBeUndefined();
      });
    });

    describe('pending auth (one-time)', () => {
      it('takes a pending record exactly once', async () => {
        const rec = makePending();
        await storage.savePendingAuth(rec);

        expect(await storage.takePendingAuth(rec.state)).toEqual(rec);
        expect(await storage.takePendingAuth(rec.state)).toBeUndefined();
      });

      it('returns undefined for an expired pending record', async () => {
        const rec = makePending({ expiresAt: Date.now() - 1000 });
        await storage.savePendingAuth(rec);
        expect(await storage.takePendingAuth(rec.state)).toBeUndefined();
      });

      it('preserves undefined clientState', async () => {
        const rec = makePending({ clientState: undefined });
        await storage.savePendingAuth(rec);
        const taken = await storage.takePendingAuth(rec.state);
        expect(taken?.clientState).toBeUndefined();
      });
    });

    describe('auth codes (one-time)', () => {
      it('takes an auth code exactly once', async () => {
        const rec = makeAuthCode();
        await storage.saveAuthCode(rec);

        expect(await storage.takeAuthCode(rec.code)).toEqual(rec);
        expect(await storage.takeAuthCode(rec.code)).toBeUndefined();
      });

      it('returns undefined for an expired auth code', async () => {
        const rec = makeAuthCode({ expiresAt: Date.now() - 1000 });
        await storage.saveAuthCode(rec);
        expect(await storage.takeAuthCode(rec.code)).toBeUndefined();
      });
    });

    describe('access tokens', () => {
      it('saves and gets a valid token repeatedly', async () => {
        const rec = makeAccessToken();
        await storage.saveAccessToken(rec);
        expect(await storage.getAccessToken(rec.token)).toEqual(rec);
        // still available on a second read (not one-time)
        expect(await storage.getAccessToken(rec.token)).toEqual(rec);
      });

      it('returns undefined for an expired token', async () => {
        const rec = makeAccessToken({ expiresAt: Date.now() - 1000 });
        await storage.saveAccessToken(rec);
        expect(await storage.getAccessToken(rec.token)).toBeUndefined();
      });

      it('deletes a token', async () => {
        const rec = makeAccessToken();
        await storage.saveAccessToken(rec);
        await storage.deleteAccessToken(rec.token);
        expect(await storage.getAccessToken(rec.token)).toBeUndefined();
      });
    });

    describe('resource binding (RFC 8707)', () => {
      const resource = 'https://mcp.example.com/mcp';

      it('round-trips a resource on pending auth, codes, access and refresh tokens', async () => {
        const pending = makePending({ resource });
        await storage.savePendingAuth(pending);
        expect((await storage.takePendingAuth(pending.state))?.resource).toBe(resource);

        const code = makeAuthCode({ resource });
        await storage.saveAuthCode(code);
        expect((await storage.takeAuthCode(code.code))?.resource).toBe(resource);

        const at = makeAccessToken({ resource });
        await storage.saveAccessToken(at);
        expect(await storage.getAccessToken(at.token)).toEqual(at);

        const rt = makeRefreshToken({ resource });
        await storage.saveRefreshToken(rt);
        expect(await storage.takeRefreshToken(rt.token)).toEqual(rt);
      });

      it('returns undefined (not null or "") for records saved without a resource', async () => {
        const pending = makePending();
        await storage.savePendingAuth(pending);
        expect((await storage.takePendingAuth(pending.state))?.resource).toBeUndefined();

        const code = makeAuthCode();
        await storage.saveAuthCode(code);
        expect((await storage.takeAuthCode(code.code))?.resource).toBeUndefined();

        const at = makeAccessToken();
        await storage.saveAccessToken(at);
        expect((await storage.getAccessToken(at.token))?.resource).toBeUndefined();

        const rt = makeRefreshToken();
        await storage.saveRefreshToken(rt);
        expect((await storage.takeRefreshToken(rt.token))?.resource).toBeUndefined();
      });

      it('keeps the resource through a pending-auth take and re-save', async () => {
        const pending = makePending({ resource });
        await storage.savePendingAuth(pending);
        const taken = await storage.takePendingAuth(pending.state);
        if (!taken) throw new Error('expected pending record');
        await storage.savePendingAuth({ ...taken, grantedScope: 'read-only' });
        const again = await storage.takePendingAuth(pending.state);
        expect(again?.resource).toBe(resource);
        expect(again?.grantedScope).toBe('read-only');
      });
    });

    describe('per-grant access level and browser binding (0.4.0)', () => {
      it('round-trips grantedScope on codes, access and refresh tokens', async () => {
        for (const grantedScope of ['read-only', 'read-write'] as const) {
          const code = makeAuthCode({ grantedScope });
          await storage.saveAuthCode(code);
          expect(await storage.takeAuthCode(code.code)).toEqual(code);

          const at = makeAccessToken({ grantedScope });
          await storage.saveAccessToken(at);
          expect(await storage.getAccessToken(at.token)).toEqual(at);

          const rt = makeRefreshToken({ grantedScope });
          await storage.saveRefreshToken(rt);
          expect(await storage.takeRefreshToken(rt.token)).toEqual(rt);
        }
      });

      it('returns undefined grantedScope / browserBinding for records saved without one', async () => {
        const code = makeAuthCode();
        await storage.saveAuthCode(code);
        expect((await storage.takeAuthCode(code.code))?.grantedScope).toBeUndefined();
        const at = makeAccessToken();
        await storage.saveAccessToken(at);
        expect((await storage.getAccessToken(at.token))?.grantedScope).toBeUndefined();
        const rt = makeRefreshToken();
        await storage.saveRefreshToken(rt);
        expect((await storage.takeRefreshToken(rt.token))?.grantedScope).toBeUndefined();
        const pending = makePending();
        await storage.savePendingAuth(pending);
        expect((await storage.takePendingAuth(pending.state))?.browserBinding).toBeUndefined();
      });

      it('keeps the browser binding through a pending-auth take and re-save', async () => {
        const pending = makePending({ browserBinding: 'hash-of-nonce' });
        await storage.savePendingAuth(pending);
        const taken = await storage.takePendingAuth(pending.state);
        expect(taken).toEqual(pending);
        if (!taken) throw new Error('expected pending record');
        await storage.savePendingAuth({ ...taken, grantedScope: 'read-only' });
        expect((await storage.takePendingAuth(pending.state))?.browserBinding).toBe('hash-of-nonce');
      });
    });

    describe('refresh tokens (one-time / rotation)', () => {
      it('takes a refresh token exactly once', async () => {
        const rec = makeRefreshToken();
        await storage.saveRefreshToken(rec);

        expect(await storage.takeRefreshToken(rec.token)).toEqual(rec);
        expect(await storage.takeRefreshToken(rec.token)).toBeUndefined();
      });

      it('supports rotation: old token invalid, new token valid', async () => {
        const oldToken = makeRefreshToken();
        await storage.saveRefreshToken(oldToken);

        const taken = await storage.takeRefreshToken(oldToken.token);
        expect(taken).toEqual(oldToken);

        // rotate in a new token
        const newToken = makeRefreshToken({ token: `rt-${randomUUID()}` });
        await storage.saveRefreshToken(newToken);

        expect(await storage.takeRefreshToken(oldToken.token)).toBeUndefined();
        expect(await storage.takeRefreshToken(newToken.token)).toEqual(newToken);
      });

      it('deletes a refresh token', async () => {
        const rec = makeRefreshToken();
        await storage.saveRefreshToken(rec);
        await storage.deleteRefreshToken(rec.token);
        expect(await storage.takeRefreshToken(rec.token)).toBeUndefined();
        expect(await storage.getRefreshToken(rec.token)).toBeUndefined();
      });

      it('looks a refresh token up without consuming it', async () => {
        const rec = makeRefreshToken({ resource: 'https://mcp.example.com/mcp', grantedScope: 'read-write' });
        await storage.saveRefreshToken(rec);

        expect(await storage.getRefreshToken(rec.token)).toEqual(rec);
        expect(await storage.getRefreshToken(rec.token)).toEqual(rec);
        expect(await storage.takeRefreshToken(rec.token)).toEqual(rec);
        // Once taken, it is gone for both.
        expect(await storage.getRefreshToken(rec.token)).toBeUndefined();
        expect(await storage.takeRefreshToken(rec.token)).toBeUndefined();
      });

      it('lets exactly one of several concurrent takes succeed', async () => {
        // exchangeRefreshToken validates with getRefreshToken and then relies on
        // takeRefreshToken as the single atomic spend; overlapping takes must not
        // both win (Postgres runs them on separate pool connections).
        const rec = makeRefreshToken();
        await storage.saveRefreshToken(rec);

        const results = await Promise.all(Array.from({ length: 5 }, () => storage.takeRefreshToken(rec.token)));

        expect(results.filter((r) => r !== undefined)).toEqual([rec]);
        expect(await storage.getRefreshToken(rec.token)).toBeUndefined();
      });

      it('lookup returns undefined for an unknown token, and undefined optional fields', async () => {
        expect(await storage.getRefreshToken(`rt-${randomUUID()}`)).toBeUndefined();
        const rec = makeRefreshToken();
        await storage.saveRefreshToken(rec);
        const got = await storage.getRefreshToken(rec.token);
        expect(got?.resource).toBeUndefined();
        expect(got?.grantedScope).toBeUndefined();
        expect(got?.familyId).toBeUndefined();
      });
    });

    describe('token families and rotation tombstones (RFC 9700)', () => {
      // Postgres runs every conformance test against the same tables, so each
      // test uses its own random family ids.
      afterEach(() => {
        vi.useRealTimers();
      });

      it('round-trips familyId on access and refresh tokens', async () => {
        const familyId = randomUUID();
        const at = makeAccessToken({ familyId });
        await storage.saveAccessToken(at);
        expect(await storage.getAccessToken(at.token)).toEqual(at);
        const rt = makeRefreshToken({ familyId });
        await storage.saveRefreshToken(rt);
        expect(await storage.getRefreshToken(rt.token)).toEqual(rt);
        expect(await storage.takeRefreshToken(rt.token)).toEqual(rt);
        const legacy = makeAccessToken();
        await storage.saveAccessToken(legacy);
        expect((await storage.getAccessToken(legacy.token))?.familyId).toBeUndefined();
      });

      it('rotates: spends the token, records its tombstone and saves the new pair', async () => {
        const familyId = randomUUID();
        const old = makeRefreshToken({ clientId: 'client-a', familyId });
        await storage.saveRefreshToken(old);
        const rotation = makeRotation(familyId);

        expect(await storage.rotateRefreshToken(old.token, rotation)).toEqual(old);
        expect(await storage.getRefreshToken(old.token)).toBeUndefined();
        expect(await storage.getConsumedRefreshToken(old.token)).toEqual({
          token: old.token,
          clientId: 'client-a',
          familyId,
          expiresAt: rotation.consumedUntil,
        });
        expect(await storage.getAccessToken(rotation.accessToken.token)).toEqual(rotation.accessToken);
        expect(await storage.getRefreshToken(rotation.refreshToken.token)).toEqual(rotation.refreshToken);
      });

      it('a legacy token (no family) is tombstoned with the family it is rotated into', async () => {
        const old = makeRefreshToken();
        await storage.saveRefreshToken(old);
        const familyId = randomUUID();
        expect(await storage.rotateRefreshToken(old.token, makeRotation(familyId))).toEqual(old);
        expect((await storage.getConsumedRefreshToken(old.token))?.familyId).toBe(familyId);
      });

      it('writes nothing when the token is not live', async () => {
        const rotation = makeRotation(randomUUID());
        const unknown = `rt-${randomUUID()}`;
        expect(await storage.rotateRefreshToken(unknown, rotation)).toBeUndefined();
        expect(await storage.getConsumedRefreshToken(unknown)).toBeUndefined();
        expect(await storage.getAccessToken(rotation.accessToken.token)).toBeUndefined();
        expect(await storage.getRefreshToken(rotation.refreshToken.token)).toBeUndefined();

        // A second rotation of a spent token neither re-saves nor overwrites.
        const familyId = randomUUID();
        const old = makeRefreshToken({ familyId });
        await storage.saveRefreshToken(old);
        const first = makeRotation(familyId);
        await storage.rotateRefreshToken(old.token, first);
        const second = makeRotation(randomUUID());
        expect(await storage.rotateRefreshToken(old.token, second)).toBeUndefined();
        expect((await storage.getConsumedRefreshToken(old.token))?.familyId).toBe(familyId);
        expect(await storage.getRefreshToken(second.refreshToken.token)).toBeUndefined();
      });

      it('lets exactly one of several concurrent rotations succeed', async () => {
        const familyId = randomUUID();
        const old = makeRefreshToken({ familyId });
        await storage.saveRefreshToken(old);
        const rotations = Array.from({ length: 5 }, () => makeRotation(familyId));

        const results = await Promise.all(rotations.map((r) => storage.rotateRefreshToken(old.token, r)));

        expect(results.filter((r) => r !== undefined)).toEqual([old]);
        const saved = await Promise.all(rotations.map((r) => storage.getRefreshToken(r.refreshToken.token)));
        expect(saved.filter((r) => r !== undefined)).toHaveLength(1);
        expect(await storage.getConsumedRefreshToken(old.token)).toBeDefined();
      });

      it('reads an expired tombstone as absent', async () => {
        const old = makeRefreshToken();
        await storage.saveRefreshToken(old);
        await storage.rotateRefreshToken(old.token, makeRotation(randomUUID(), { consumedUntil: Date.now() - 1 }));
        expect(await storage.getConsumedRefreshToken(old.token)).toBeUndefined();
      });

      it('prunes expired tombstones when it records a new one', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        const stale = makeRefreshToken();
        const kept = makeRefreshToken();
        await storage.saveRefreshToken(stale);
        await storage.saveRefreshToken(kept);
        await storage.rotateRefreshToken(stale.token, makeRotation(randomUUID(), { consumedUntil: t0 + 1000 }));
        await storage.rotateRefreshToken(kept.token, makeRotation(randomUUID(), { consumedUntil: t0 + 10_000 }));

        // Later, another rotation prunes the expired tombstone and keeps the live one...
        vi.setSystemTime(t0 + 5000);
        const next = makeRefreshToken();
        await storage.saveRefreshToken(next);
        await storage.rotateRefreshToken(next.token, makeRotation(randomUUID()));

        // ...which shows once the clock is back before its expiry: it is gone.
        vi.setSystemTime(t0);
        expect(await storage.getConsumedRefreshToken(stale.token)).toBeUndefined();
        expect(await storage.getConsumedRefreshToken(kept.token)).toBeDefined();
      });

      it('deletes every access and refresh token of a family, and nothing else', async () => {
        const familyId = randomUUID();
        const other = randomUUID();
        const members = [makeAccessToken({ familyId }), makeAccessToken({ familyId })];
        const memberRefresh = makeRefreshToken({ familyId });
        const otherAt = makeAccessToken({ familyId: other });
        const otherRt = makeRefreshToken({ familyId: other });
        const legacyAt = makeAccessToken();
        const legacyRt = makeRefreshToken();
        for (const at of [...members, otherAt, legacyAt]) await storage.saveAccessToken(at);
        for (const rt of [memberRefresh, otherRt, legacyRt]) await storage.saveRefreshToken(rt);

        await storage.deleteTokenFamily(familyId);

        for (const at of members) expect(await storage.getAccessToken(at.token)).toBeUndefined();
        expect(await storage.getRefreshToken(memberRefresh.token)).toBeUndefined();
        expect(await storage.getAccessToken(otherAt.token)).toEqual(otherAt);
        expect(await storage.getRefreshToken(otherRt.token)).toEqual(otherRt);
        expect(await storage.getAccessToken(legacyAt.token)).toEqual(legacyAt);
        expect(await storage.getRefreshToken(legacyRt.token)).toEqual(legacyRt);
        // An unknown family is a no-op.
        await expect(storage.deleteTokenFamily(randomUUID())).resolves.toBeUndefined();
      });
    });
  });
}

// --- Upgrading a database created by 0.3.x ---

/** The 0.3.x schema, verbatim (SQLite flavor; Postgres uses BIGINT for the integers). */
function legacySchema(int: 'INTEGER' | 'BIGINT'): string {
  return `
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY, granted_scope TEXT NOT NULL,
      encrypted_refresh_token TEXT NOT NULL, updated_at ${int} NOT NULL
    );
    CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_json TEXT NOT NULL);
    CREATE TABLE pending_auth (
      state TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL, client_state TEXT, scopes TEXT NOT NULL,
      granted_scope TEXT NOT NULL, expires_at ${int} NOT NULL
    );
    CREATE TABLE auth_codes (
      code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scopes TEXT NOT NULL,
      expires_at ${int} NOT NULL
    );
    CREATE TABLE access_tokens (
      token TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
      scopes TEXT NOT NULL, expires_at ${int} NOT NULL
    );
    CREATE TABLE refresh_tokens (
      token TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL
    );
  `;
}

/** Rows as 0.3.x wrote them (no resource column anywhere). */
function legacyRows(expiresAt: number): string {
  return `
    INSERT INTO users VALUES ('legacy-user', 'read-write', 'enc', 1);
    INSERT INTO pending_auth VALUES ('legacy-state', 'c1', 'https://client/cb', 'chal', NULL, '[]', 'read-only', ${expiresAt});
    INSERT INTO auth_codes VALUES ('legacy-code', 'c1', 'legacy-user', 'https://client/cb', 'chal', '["read-only"]', ${expiresAt});
    INSERT INTO access_tokens VALUES ('legacy-at', 'c1', 'legacy-user', '["read-only"]', ${expiresAt});
    INSERT INTO refresh_tokens VALUES ('legacy-rt', 'c1', 'legacy-user', '["read-only"]');
    INSERT INTO refresh_tokens VALUES ('legacy-rt-2', 'c1', 'legacy-user', '["read-only"]');
  `;
}

const RESOURCE_TABLES = ['pending_auth', 'auth_codes', 'access_tokens', 'refresh_tokens'] as const;
/** Every column added since 0.3.x, by table (mirrors ADDED_COLUMNS). */
const ADDED: Record<(typeof RESOURCE_TABLES)[number], string[]> = {
  pending_auth: ['resource', 'browser_binding'],
  auth_codes: ['resource', 'granted_scope'],
  access_tokens: ['resource', 'granted_scope', 'family_id'],
  refresh_tokens: ['resource', 'granted_scope', 'family_id'],
};

/**
 * Open a 0.3.x database with the current driver twice and check that legacy rows
 * still read (with no resource or family), new rows carry them, a legacy refresh
 * token rotates into a family (so the tombstone table exists), and re-running
 * init() is a no-op that adds each new column exactly once.
 */
async function checkLegacyUpgrade(
  open: () => Promise<Storage>,
  columnsOf: (table: string) => Promise<string[]>
): Promise<void> {
  const first = await open();
  try {
    expect(await first.getUser('legacy-user')).toMatchObject({ grantedScope: 'read-write' });
    expect(await first.getAccessToken('legacy-at')).toEqual({
      token: 'legacy-at',
      clientId: 'c1',
      userId: 'legacy-user',
      scopes: ['read-only'],
      expiresAt: expect.any(Number),
      resource: undefined,
    });
    expect((await first.getAccessToken('legacy-at'))?.grantedScope).toBeUndefined();
    const legacyCode = await first.takeAuthCode('legacy-code');
    expect(legacyCode).toMatchObject({ code: 'legacy-code', clientId: 'c1', userId: 'legacy-user' });
    expect(legacyCode?.resource).toBeUndefined();
    expect(legacyCode?.grantedScope).toBeUndefined();
    const legacyPending = await first.takePendingAuth('legacy-state');
    expect(legacyPending).toMatchObject({ state: 'legacy-state', clientId: 'c1' });
    expect(legacyPending?.resource).toBeUndefined();
    expect(legacyPending?.browserBinding).toBeUndefined();
    const legacyRefresh = await first.takeRefreshToken('legacy-rt');
    expect(legacyRefresh?.userId).toBe('legacy-user');
    expect(legacyRefresh?.resource).toBeUndefined();
    expect(legacyRefresh?.grantedScope).toBeUndefined();
    expect(legacyRefresh?.familyId).toBeUndefined();
    expect((await first.getAccessToken('legacy-at'))?.familyId).toBeUndefined();

    await first.saveAccessToken(
      makeAccessToken({ token: 'new-at', resource: 'https://r.example/mcp', grantedScope: 'read-write' })
    );
    const rotated = await first.rotateRefreshToken(
      'legacy-rt-2',
      makeRotation('legacy-family', {
        accessToken: makeAccessToken({ token: 'family-at', familyId: 'legacy-family' }),
        refreshToken: makeRefreshToken({ token: 'family-rt', familyId: 'legacy-family' }),
      })
    );
    expect(rotated).toMatchObject({ token: 'legacy-rt-2', clientId: 'c1', familyId: undefined });
  } finally {
    await first.close();
  }

  const second = await open();
  try {
    expect((await second.getAccessToken('new-at'))?.resource).toBe('https://r.example/mcp');
    expect((await second.getAccessToken('new-at'))?.grantedScope).toBe('read-write');
    expect((await second.getAccessToken('legacy-at'))?.resource).toBeUndefined();
    expect(await second.getConsumedRefreshToken('legacy-rt-2')).toMatchObject({
      clientId: 'c1',
      familyId: 'legacy-family',
    });
    expect((await second.getRefreshToken('family-rt'))?.familyId).toBe('legacy-family');
    await second.deleteTokenFamily('legacy-family');
    expect(await second.getAccessToken('family-at')).toBeUndefined();
    expect(await second.getRefreshToken('family-rt')).toBeUndefined();
    expect((await second.getAccessToken('legacy-at'))?.token).toBe('legacy-at');
  } finally {
    await second.close();
  }

  for (const table of RESOURCE_TABLES) {
    const cols = await columnsOf(table);
    for (const added of ADDED[table]) {
      expect(cols.filter((c) => c === added), `${table}.${added}`).toHaveLength(1);
    }
  }
}

// --- MemoryStorage (always) ---
runStorageConformance('MemoryStorage', async () => {
  const s = new MemoryStorage();
  await s.init();
  return s;
});

// --- SqliteStorage (skipped if better-sqlite3 can't be loaded/built) ---
// Detect availability synchronously at collection time (no top-level await, which
// would change vitest's file scheduling) so the describe below can be skipped.
const sqliteAvailable = ((): boolean => {
  try {
    // Actually load (not just resolve) so an unbuildable native addon → skip.
    createRequire(import.meta.url)('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();

// CI sets REQUIRE_DB_TESTS=1 so a missing driver or database fails instead of silently skipping.
const requireDbTests = process.env.REQUIRE_DB_TESTS === '1';

describe.skipIf(!sqliteAvailable && !requireDbTests)('SqliteStorage suite', () => {
  if (requireDbTests) {
    it('has better-sqlite3 available (REQUIRE_DB_TESTS=1)', () => {
      expect(sqliteAvailable).toBe(true);
    });
  }

  const sqliteFiles: string[] = [];

  runStorageConformance('SqliteStorage', async () => {
    const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
    const file = join(tmpdir(), `ynab-mcp-sqlite-${randomUUID()}.db`);
    sqliteFiles.push(file);
    const s = new SqliteStorage({ path: file });
    await s.init();
    return s;
  });

  it('upgrades a 0.3.x SQLite database in place (idempotent)', async () => {
    const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
    const file = join(tmpdir(), `ynab-mcp-sqlite-legacy-${randomUUID()}.db`);
    sqliteFiles.push(file);
    const raw = new Database(file);
    raw.exec(legacySchema('INTEGER'));
    raw.exec(legacyRows(Date.now() + 3_600_000));
    raw.close();

    await checkLegacyUpgrade(
      async () => {
        const s = new SqliteStorage({ path: file });
        await s.init();
        return s;
      },
      async (table) => {
        const db = new Database(file, { readonly: true });
        try {
          return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (c) => c.name
          );
        } finally {
          db.close();
        }
      }
    );
  });

  afterAll(() => {
    for (const f of sqliteFiles) {
      rmSync(f, { force: true });
      rmSync(`${f}-wal`, { force: true });
      rmSync(`${f}-shm`, { force: true });
    }
  });
});

// --- PostgresStorage (only when DATABASE_URL is set) ---
describe.skipIf(!process.env.DATABASE_URL && !requireDbTests)('PostgresStorage suite', () => {
  if (requireDbTests) {
    it('has DATABASE_URL set (REQUIRE_DB_TESTS=1)', () => {
      expect(process.env.DATABASE_URL).toBeTruthy();
    });
  }

  it('upgrades a 0.3.x Postgres schema in place (idempotent)', async () => {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const pg = (await import('pg')).default;
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL not set');
    // An isolated schema so the legacy tables don't collide with the conformance suite's.
    const schema = `legacy_${randomUUID().replace(/-/g, '')}`;
    const url = new URL(base);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const connectionString = url.toString();

    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const raw = new pg.Pool({ connectionString });
      try {
        await raw.query(legacySchema('BIGINT'));
        await raw.query(legacyRows(Date.now() + 3_600_000));
      } finally {
        await raw.end();
      }

      await checkLegacyUpgrade(
        async () => {
          const s = new PostgresStorage({ connectionString });
          await s.init();
          return s;
        },
        async (table) => {
          const res = await admin.query<{ column_name: string }>(
            'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
            [schema, table]
          );
          return res.rows.map((r) => r.column_name);
        }
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('initializes a fresh schema from several replicas at once', async () => {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const pg = (await import('pg')).default;
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL not set');
    const schema = `fresh_${randomUUID().replace(/-/g, '')}`;
    const url = new URL(base);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const replicas = Array.from(
        { length: 4 },
        () => new PostgresStorage({ connectionString: url.toString() })
      );
      await Promise.all(replicas.map((r) => r.init()));
      await replicas[0]?.saveAccessToken(makeAccessToken({ token: 'at-1', resource: 'https://r/mcp' }));
      expect((await replicas[1]?.getAccessToken('at-1'))?.resource).toBe('https://r/mcp');
      await Promise.all(replicas.map((r) => r.close()));
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  describe('token family lock (rotation vs. revocation in flight)', () => {
    /** Resolves after `ms`, to let a query reach (and block on) its lock. */
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Tracks whether a promise has settled yet. */
    function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
      let done = false;
      const promise = p.finally(() => {
        done = true;
      });
      return { promise, settled: () => done };
    }

    async function setup() {
      const { PostgresStorage, LOCK_FAMILY } = await import('../../../src/storage/postgres.js');
      const pg = (await import('pg')).default;
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL not set');
      const storage = new PostgresStorage({ connectionString });
      await storage.init();
      const raw = new pg.Pool({ connectionString });
      return { storage, raw, LOCK_FAMILY };
    }

    it('revoking a family waits for a rotation in flight and removes the pair it saved', async () => {
      const { storage, raw, LOCK_FAMILY } = await setup();
      const tx = await raw.connect();
      try {
        const familyId = randomUUID();
        const spent = makeRefreshToken({ familyId });
        await storage.saveRefreshToken(spent);
        const next = makeRotation(familyId);

        // A rotation by hand, left uncommitted: spend the token, save the new pair.
        await tx.query('BEGIN');
        await tx.query(LOCK_FAMILY, [familyId]);
        await tx.query('DELETE FROM refresh_tokens WHERE token = $1', [spent.token]);
        await tx.query(
          `INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, family_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [next.accessToken.token, 'client-1', 'user-1', '["read"]', Date.now() + 60_000, familyId]
        );
        await tx.query(
          `INSERT INTO refresh_tokens (token, client_id, user_id, scopes, family_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [next.refreshToken.token, 'client-1', 'user-1', '["read"]', familyId]
        );

        const revoke = track(storage.deleteTokenFamily(familyId));
        await pause(200);
        expect(revoke.settled()).toBe(false);
        await tx.query('COMMIT');
        await revoke.promise;

        expect(await storage.getAccessToken(next.accessToken.token)).toBeUndefined();
        expect(await storage.getRefreshToken(next.refreshToken.token)).toBeUndefined();
      } finally {
        await tx.query('ROLLBACK').catch(() => undefined);
        tx.release();
        await raw.end();
        await storage.close();
      }
    });

    it('a rotation waits while its family is being revoked', async () => {
      const { storage, raw, LOCK_FAMILY } = await setup();
      const tx = await raw.connect();
      try {
        const familyId = randomUUID();
        const old = makeRefreshToken({ familyId });
        await storage.saveRefreshToken(old);

        await tx.query('BEGIN');
        await tx.query(LOCK_FAMILY, [familyId]);
        const rotation = makeRotation(familyId);
        const rotate = track(storage.rotateRefreshToken(old.token, rotation));
        await pause(200);
        expect(rotate.settled()).toBe(false);
        expect(await storage.getRefreshToken(old.token)).toEqual(old);
        await tx.query('COMMIT');

        expect(await rotate.promise).toEqual(old);
        expect(await storage.getRefreshToken(rotation.refreshToken.token)).toEqual(rotation.refreshToken);
        // Another family is not held up by the lock.
        const otherFamily = randomUUID();
        const other = makeRefreshToken({ familyId: otherFamily });
        await storage.saveRefreshToken(other);
        await tx.query('BEGIN');
        await tx.query(LOCK_FAMILY, [familyId]);
        expect(await storage.rotateRefreshToken(other.token, makeRotation(otherFamily))).toEqual(other);
        await tx.query('COMMIT');
      } finally {
        await tx.query('ROLLBACK').catch(() => undefined);
        tx.release();
        await raw.end();
        await storage.close();
      }
    });
  });

  runStorageConformance('PostgresStorage', async () => {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    const s = new PostgresStorage({ connectionString });
    await s.init();
    return s;
  });
});
