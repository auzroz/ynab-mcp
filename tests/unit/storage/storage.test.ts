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
  `;
}

const RESOURCE_TABLES = ['pending_auth', 'auth_codes', 'access_tokens', 'refresh_tokens'] as const;
/** Every column added since 0.3.x, by table (mirrors ADDED_COLUMNS). */
const ADDED: Record<(typeof RESOURCE_TABLES)[number], string[]> = {
  pending_auth: ['resource', 'browser_binding'],
  auth_codes: ['resource', 'granted_scope'],
  access_tokens: ['resource', 'granted_scope'],
  refresh_tokens: ['resource', 'granted_scope'],
};

/**
 * Open a 0.3.x database with the current driver twice and check that legacy rows
 * still read (with no resource), new rows carry one, and re-running init() is a
 * no-op that adds each new column exactly once.
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
    expect(legacyCode?.resource).toBeUndefined();
    expect(legacyCode?.grantedScope).toBeUndefined();
    const legacyPending = await first.takePendingAuth('legacy-state');
    expect(legacyPending?.resource).toBeUndefined();
    expect(legacyPending?.browserBinding).toBeUndefined();
    const legacyRefresh = await first.takeRefreshToken('legacy-rt');
    expect(legacyRefresh?.userId).toBe('legacy-user');
    expect(legacyRefresh?.resource).toBeUndefined();
    expect(legacyRefresh?.grantedScope).toBeUndefined();

    await first.saveAccessToken(
      makeAccessToken({ token: 'new-at', resource: 'https://r.example/mcp', grantedScope: 'read-write' })
    );
  } finally {
    await first.close();
  }

  const second = await open();
  try {
    expect((await second.getAccessToken('new-at'))?.resource).toBe('https://r.example/mcp');
    expect((await second.getAccessToken('new-at'))?.grantedScope).toBe('read-write');
    expect((await second.getAccessToken('legacy-at'))?.resource).toBeUndefined();
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

  runStorageConformance('PostgresStorage', async () => {
    const { PostgresStorage } = await import('../../../src/storage/postgres.js');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    const s = new PostgresStorage({ connectionString });
    await s.init();
    return s;
  });
});
