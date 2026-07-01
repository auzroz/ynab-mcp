/**
 * Shared conformance suite for the Storage interface.
 *
 * The `runStorageConformance` function is parameterized by a Storage factory and
 * run against every durable and in-memory adapter, so all drivers are held to
 * identical semantics: user CRUD, client persistence, one-time take semantics for
 * pending-auth / auth-codes / refresh-tokens, and access-token expiry.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
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
      });
    });
  });
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

describe.skipIf(!sqliteAvailable)('SqliteStorage suite', () => {
  const sqliteFiles: string[] = [];

  runStorageConformance('SqliteStorage', async () => {
    const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
    const file = join(tmpdir(), `ynab-mcp-sqlite-${randomUUID()}.db`);
    sqliteFiles.push(file);
    const s = new SqliteStorage({ path: file });
    await s.init();
    return s;
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
describe.skipIf(!process.env.DATABASE_URL)('PostgresStorage suite', () => {
  runStorageConformance('PostgresStorage', async () => {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    const s = new PostgresStorage({ connectionString });
    await s.init();
    return s;
  });
});
