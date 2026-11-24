/**
 * Migration M3 (#52) on SQLite and Postgres (gates G7 and G8 at the storage
 * layer): the pepper check, the eager rehash of 0.4.x keys in every keyed
 * table, hashed DCR client secrets and idempotency. Since the cut-over to
 * oidc-provider (#47-4, ADR-0002 D12) M4 runs right after M3: the client M3
 * hashed is converted and keeps its secret, and the 0.4.x token, refresh
 * token and code M3 rehashed are kept for rollback but refused, because no
 * code reads the 0.4.x tables any more. Memory storage has nothing from an
 * earlier process to migrate; its at-rest check is in
 * tests/unit/auth/token-hash-provider.test.ts.
 *
 * Each test gets its own SQLite file or Postgres schema, because the pepper
 * fingerprint is per database.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '../../../src/storage/types.js';
import { SCHEMA_VERSION } from '../../../src/storage/migrations.js';
import {
  PEPPER_FINGERPRINT_KEY,
  PEPPER_MISMATCH_MESSAGE,
} from '../../../src/storage/token-hashing-migration.js';
import { TokenHasher, verifyClientSecret, type TokenKeyDeriver } from '../../../src/auth/token-hash.js';
import { createOidcProvider } from '../../../src/auth/oidc/provider.js';
import { createAccessTokenVerifier } from '../../../src/auth/oidc/verifier.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER, legacyToken, testKey } from '../helpers/token-hasher.js';
import { expectInvalidToken } from '../helpers/invalid-token.js';

/** Raw access to one test database, beside the storage under test. */
interface TestDb {
  open(keys: TokenKeyDeriver | undefined): Promise<Storage>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  rows<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
}

const sqliteAvailable = ((): boolean => {
  try {
    createRequire(import.meta.url)('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const requireDbTests = process.env.REQUIRE_DB_TESTS === '1';
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function sqliteDb(): Promise<TestDb> {
  const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
  const file = join(tmpdir(), `ynab-mcp-m3-${randomUUID()}.db`);
  cleanups.push(async () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
  const raw = <T>(fn: (db: import('better-sqlite3').Database) => T): T => {
    const db = new Database(file);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const toSqlite = (sql: string): string => sql.replace(/\$\d+/g, '?');
  return {
    open: async (keys) => {
      const s = new SqliteStorage({ path: file, tokenKeys: keys as TokenKeyDeriver });
      await s.init();
      return s;
    },
    exec: async (sql, params = []) => {
      raw((db) => db.prepare(toSqlite(sql)).run(...params));
    },
    rows: async <T extends object>(sql: string, params: unknown[] = []) =>
      raw((db) => db.prepare(toSqlite(sql)).all(...params) as T[]),
  };
}

async function postgresDb(): Promise<TestDb> {
  const { PostgresStorage } = await import('../../../src/storage/postgres.js');
  const pg = (await import('pg')).default;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL not set (REQUIRE_DB_TESTS=1)');
  const schema = `m3_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const connectionString = url.toString();
  const pool = new pg.Pool({ connectionString });
  cleanups.push(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  return {
    open: async (keys) => {
      const s = new PostgresStorage({ connectionString, tokenKeys: keys as TokenKeyDeriver });
      await s.init();
      return s;
    },
    exec: async (sql, params = []) => {
      await pool.query(sql, params);
    },
    rows: async <T extends object>(sql: string, params: unknown[] = []) =>
      (await pool.query<T & import('pg').QueryResultRow>(sql, params)).rows,
  };
}

const TABLES = [
  'users',
  'oauth_clients',
  'pending_auth',
  'auth_codes',
  'access_tokens',
  'refresh_tokens',
  'consumed_refresh_tokens',
  'consumed_auth_codes',
  // M4's table: the converted Client row (its secret stored only as the s256. hash).
  'oauth_rows',
  'schema_meta',
];

/** Every row of every table, as one string, in a stable order. */
async function dump(db: TestDb): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const rows = await db.rows<Record<string, unknown>>(`SELECT * FROM ${table}`);
    out[table] = rows
      .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k] === null ? null : String(r[k])])))
      .sort();
  }
  return JSON.stringify(out);
}

/** The values a 0.4.x (or pre-M3 0.5.0) server had issued, planted as it stored them. */
interface Planted {
  accessToken: string;
  refreshToken: string;
  code: string;
  state: string;
  stateNonce: string;
  replayedRefresh: string;
  replayedCode: string;
  clientSecret: string;
  clientId: string;
}

const FUTURE = (): number => Date.now() + 3_600_000;

async function plantLegacyRows(db: TestDb, opts: { withCodeTombstone: boolean }): Promise<Planted> {
  const p: Planted = {
    accessToken: legacyToken(),
    refreshToken: legacyToken(),
    code: legacyToken(),
    state: legacyToken(),
    stateNonce: '',
    replayedRefresh: legacyToken(),
    replayedCode: legacyToken(),
    clientSecret: randomBytes(32).toString('hex'),
    clientId: `legacy-client-${randomUUID()}`,
  };
  const client = {
    client_id: p.clientId,
    client_id_issued_at: 1,
    client_name: 'Legacy',
    redirect_uris: ['https://client/cb'],
    client_secret: p.clientSecret,
    client_secret_expires_at: 0,
  };
  await db.exec('INSERT INTO oauth_clients (client_id, client_json) VALUES ($1, $2)', [p.clientId, JSON.stringify(client)]);
  // 0.4.1 kept a users row for every connected user; STOR-1 reads tokens only through it.
  await db.exec('INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at) VALUES ($1, $2, $3, $4)', [
    'u-legacy',
    'read-only',
    'x',
    Date.now(),
  ]);
  await db.exec(
    'INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, granted_scope) VALUES ($1, $2, $3, $4, $5, $6)',
    [p.accessToken, p.clientId, 'u-legacy', '["read-only"]', FUTURE(), 'read-only']
  );
  await db.exec(
    'INSERT INTO refresh_tokens (token, client_id, user_id, scopes, granted_scope, family_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [p.refreshToken, p.clientId, 'u-legacy', '["read-only"]', 'read-only', 'fam-live']
  );
  await db.exec(
    'INSERT INTO auth_codes (code, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at, granted_scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [p.code, p.clientId, 'u-legacy', 'https://client/cb', 'chal', '[]', FUTURE(), 'read-only']
  );
  // 0.4.x bound a pending authorization to the browser by the SHA-256 of a cookie nonce.
  const nonce = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(nonce).digest('base64url');
  p.stateNonce = nonce;
  await db.exec(
    'INSERT INTO pending_auth (state, client_id, redirect_uri, code_challenge, client_state, scopes, granted_scope, expires_at, browser_binding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [p.state, p.clientId, 'https://client/cb', 'chal', 'cs', '[]', 'read-only', FUTURE(), hash]
  );
  // A rotated refresh token's tombstone, and a live token of the family its replay revokes.
  await db.exec('INSERT INTO consumed_refresh_tokens (token, client_id, family_id, expires_at) VALUES ($1, $2, $3, $4)', [
    p.replayedRefresh,
    p.clientId,
    'fam-reused',
    FUTURE(),
  ]);
  await db.exec(
    'INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, family_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [legacyToken(), p.clientId, 'u-legacy', '[]', FUTURE(), 'fam-reused']
  );
  if (opts.withCodeTombstone) {
    await db.exec(
      'INSERT INTO consumed_auth_codes (code, client_id, user_id, family_id, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [p.replayedCode, p.clientId, 'u-legacy', 'fam-code', FUTURE()]
    );
    await db.exec(
      'INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, family_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [legacyToken(), p.clientId, 'u-legacy', '[]', FUTURE(), 'fam-code']
    );
  }
  return p;
}

/** The authorization server's library over `storage`, as as-router.ts builds it. */
function libraryFor(storage: Storage) {
  const oidc = createOidcProvider({
    store: storage,
    keys: TEST_TOKEN_HASHER,
    publicUrl: 'https://mcp.example.com',
    encryptionKey: randomBytes(32).toString('base64'),
    accessTokenTtlSec: 3600,
    authCodeTtlSec: 600,
  });
  return { provider: oidc.provider, verifier: createAccessTokenVerifier({ provider: oidc.provider, resource: oidc.resource }) };
}

/** A database as 0.4.1 left it: this schema without schema_meta rows or the M1 table. */
async function make041(db: TestDb): Promise<void> {
  await (await db.open(TEST_TOKEN_HASHER)).close();
  await db.exec('DELETE FROM schema_meta');
  await db.exec('DROP TABLE consumed_auth_codes');
}

/** A database as a 0.5.0 build before M3 left it (schema version 2, the M1 table present). */
async function makePreM3(db: TestDb): Promise<void> {
  await (await db.open(TEST_TOKEN_HASHER)).close();
  await db.exec('DELETE FROM schema_meta WHERE key = $1', [PEPPER_FINGERPRINT_KEY]);
  await db.exec('UPDATE schema_meta SET value = $1 WHERE key = $2', ['2', 'schema_version']);
}

const meta = async (db: TestDb, key: string): Promise<string | undefined> =>
  (await db.rows<{ value: string }>('SELECT value FROM schema_meta WHERE key = $1', [key]))[0]?.value;

function runM3Suite(name: string, enabled: boolean, newDb: () => Promise<TestDb>): void {
  describe.skipIf(!enabled)(`M3 token hashing: ${name}`, () => {
    it('upgrades a 0.4.1 database: every key hashed, secrets hashed, the fingerprint recorded', async () => {
      const db = await newDb();
      await make041(db);
      const p = await plantLegacyRows(db, { withCodeTombstone: false });
      const storage = await db.open(TEST_TOKEN_HASHER);
      await storage.close();

      expect(await meta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
      expect(await meta(db, PEPPER_FINGERPRINT_KEY)).toBe(TEST_TOKEN_HASHER.fingerprint);
      // G8: nothing a client holds is left in any column.
      const all = await dump(db);
      for (const value of [p.accessToken, p.refreshToken, p.code, p.state, p.replayedRefresh, p.clientSecret]) {
        expect(all).not.toContain(value);
      }
      for (const [table, column] of [
        ['access_tokens', 'token'],
        ['refresh_tokens', 'token'],
        ['auth_codes', 'code'],
        ['pending_auth', 'state'],
        ['consumed_refresh_tokens', 'token'],
      ] as const) {
        const keys = await db.rows<{ k: string }>(`SELECT ${column} AS k FROM ${table}`);
        expect(keys.length).toBeGreaterThan(0);
        for (const { k } of keys) expect(k).toMatch(/^h1\.[0-9a-f]{64}$/);
      }
      expect(await db.rows('SELECT token FROM access_tokens WHERE token = $1', [testKey('access', p.accessToken)])).toHaveLength(1);
      const [client] = await db.rows<{ client_json: string }>('SELECT client_json FROM oauth_clients WHERE client_id = $1', [p.clientId]);
      const stored = JSON.parse(client!.client_json) as Record<string, unknown>;
      expect(stored['client_secret']).toBeUndefined();
      expect(stored['client_secret_hash']).toMatch(/^s256\.[0-9a-f]{64}$/);
      expect(stored['client_secret_expires_at']).toBe(0);
    });

    it('D12: after M3 and M4 the client keeps its secret; the 0.4.x token, refresh token and code are kept but refused', async () => {
      const db = await newDb();
      await makePreM3(db);
      const p = await plantLegacyRows(db, { withCodeTombstone: true });
      const storage = await db.open(TEST_TOKEN_HASHER);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const before = await dump(db);
      try {
        const { provider, verifier } = libraryFor(storage);
        // M4 converted the client M3 hashed: the plaintext secret the client holds verifies against the stored hash.
        const client = await provider.Client.find(p.clientId);
        expect(client).toBeDefined();
        expect(verifyClientSecret(p.clientSecret, client?.clientSecret as string)).toBe(true);

        // No code reads the 0.4.x tables: their values are unknown to the library and the verifier.
        await expectInvalidToken(verifier.verifyAccessToken(p.accessToken));
        for (const value of [p.refreshToken, p.replayedRefresh]) {
          expect(await provider.RefreshToken.find(value, { ignoreExpiration: true })).toBeUndefined();
        }
        for (const value of [p.code, p.replayedCode]) {
          expect(await provider.AuthorizationCode.find(value, { ignoreExpiration: true })).toBeUndefined();
        }
        // The stored keys themselves are never credentials either.
        await expectInvalidToken(verifier.verifyAccessToken(testKey('access', p.accessToken)));
      } finally {
        errors.mockRestore();
        await storage.close();
      }
      // Kept as M3 left them (for a rollback), untouched by the lookups, and still hashed.
      const after = await dump(db);
      expect(after).toBe(before);
      expect(after).toContain(testKey('access', p.accessToken));
      for (const value of [p.accessToken, p.refreshToken, p.code, p.state, p.clientSecret]) expect(after).not.toContain(value);
      // The snapshot covers M4's converted Client row: its secret is only the hash.
      const converted = await db.rows<{ payload: string }>("SELECT payload FROM oauth_rows WHERE model = 'Client' AND client_id = $1", [p.clientId]);
      expect(converted).toHaveLength(1);
      expect(JSON.parse(converted[0]!.payload)).toMatchObject({ client_secret_hash: expect.stringMatching(/^s256\.[0-9a-f]{64}$/) });
      expect((JSON.parse(after) as Record<string, string[]>)['oauth_rows']!.some((row) => row.includes(p.clientId))).toBe(true);
    });

    it('is idempotent: a second start writes nothing; a row written later by 0.4.x is converted at the next start', async () => {
      const db = await newDb();
      await make041(db);
      const p = await plantLegacyRows(db, { withCodeTombstone: false });
      await (await db.open(TEST_TOKEN_HASHER)).close();
      const first = await dump(db);
      await (await db.open(TEST_TOKEN_HASHER)).close();
      await (await db.open(TEST_TOKEN_HASHER)).close();
      expect(await dump(db)).toBe(first);

      // A 0.4.x replica (or a rollback) writes plaintext after the stamp.
      const late = legacyToken();
      await db.exec('INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at) VALUES ($1, $2, $3, $4)', [
        'u-late',
        'read-only',
        'x',
        Date.now(),
      ]);
      await db.exec('INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at) VALUES ($1, $2, $3, $4, $5)', [
        late,
        p.clientId,
        'u-late',
        '[]',
        FUTURE(),
      ]);
      const storage = await db.open(TEST_TOKEN_HASHER);
      try {
        expect(await storage.getAccessToken(testKey('access', late))).toMatchObject({ userId: 'u-late' });
      } finally {
        await storage.close();
      }
      expect(await dump(db)).not.toContain(late);
    });

    it('keeps the hashed row when a value is stored both ways, and leaves keys of other shapes alone', async () => {
      const db = await newDb();
      await (await db.open(TEST_TOKEN_HASHER)).close();
      const both = legacyToken();
      const insert = (token: string, user: string): Promise<void> =>
        db.exec('INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at) VALUES ($1, $2, $3, $4, $5)', [
          token,
          'c',
          user,
          '[]',
          FUTURE(),
        ]);
      await insert(both, 'u-plain');
      await insert(testKey('access', both), 'u-hashed');
      await insert('odd-key-never-issued', 'u-odd');
      await (await db.open(TEST_TOKEN_HASHER)).close();
      const rows = await db.rows<{ token: string; user_id: string }>('SELECT token, user_id FROM access_tokens');
      expect(rows.map((r) => [r.token, r.user_id]).sort()).toEqual(
        [
          [testKey('access', both), 'u-hashed'],
          ['odd-key-never-issued', 'u-odd'],
        ].sort()
      );
    });

    it('refuses to start with another pepper, without a value in the error, and changes nothing', async () => {
      const db = await newDb();
      await (await db.open(TEST_TOKEN_HASHER)).close();
      const plaintext = legacyToken();
      await db.exec('INSERT INTO refresh_tokens (token, client_id, user_id, scopes) VALUES ($1, $2, $3, $4)', [
        plaintext,
        'c',
        'u',
        '[]',
      ]);
      const before = await dump(db);
      const otherPepper = randomBytes(32).toString('base64');
      const other = TokenHasher.fromSecrets({ tokenPepper: otherPepper });

      const err = (await db.open(other).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(PEPPER_MISMATCH_MESSAGE);
      for (const secret of [otherPepper, TEST_TOKEN_PEPPER, other.fingerprint, TEST_TOKEN_HASHER.fingerprint, plaintext]) {
        expect(err.message).not.toContain(secret);
      }
      // Rolled back: the plaintext row was not rehashed under the wrong pepper.
      expect(await dump(db)).toBe(before);

      // The ENCRYPTION_KEY fallback is a different pepper too.
      await expect(db.open(TokenHasher.fromSecrets({ encryptionKey: randomBytes(32).toString('base64') }))).rejects.toThrow(
        PEPPER_MISMATCH_MESSAGE
      );
      // The original pepper still starts, and converts the row.
      await (await db.open(TEST_TOKEN_HASHER)).close();
      expect(await dump(db)).not.toContain(plaintext);
    });

    it('refuses to migrate without the token hasher', async () => {
      const db = await newDb();
      await expect(db.open(undefined)).rejects.toThrow(/without the token hasher/);
    });
  });
}

runM3Suite('SqliteStorage', sqliteAvailable || requireDbTests, sqliteDb);
runM3Suite('PostgresStorage', Boolean(process.env.DATABASE_URL) || requireDbTests, postgresDb);
