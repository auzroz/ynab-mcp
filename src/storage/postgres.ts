/**
 * PostgreSQL storage adapter (durable, multi-node).
 *
 * Backed by `pg`, imported lazily so the dependency is only required when this
 * driver is selected. Uses a connection pool with parameterized queries. Scopes
 * arrays and full client objects are stored as JSON TEXT. One-time records (auth
 * codes, refresh tokens, pending auth) are deleted-and-returned atomically via a
 * `DELETE ... RETURNING` statement; a refresh-token rotation runs that statement
 * and writes the tombstone and new tokens in one transaction, and spending a
 * code at the token endpoint writes the code's tombstone in the same statement.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Pool as PgPool, PoolClient, QueryResultRow } from 'pg';
import type {
  Storage,
  UserRecord,
  AuthCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  RefreshTokenRotation,
  ConsumedRefreshTokenRecord,
  ConsumedAuthCodeRecord,
  AuthCodeConsumption,
  CodeTokens,
  PendingAuthRecord,
  ConnectionRecord,
  StorageDriverOptions,
  SweepOptions,
  SweepResult,
} from './types.js';
import { applyMigrations, type MigrationTx } from './migrations.js';
import { parseGrantedScope, parseOptionalGrantedScope } from '../auth/scope.js';
import { retentionPolicy, type RetentionPolicy } from '../auth/retention-defaults.js';
import {
  connectionsFromRows,
  emptySweepCounts,
  issuedUnderUser,
  issuedUnderUserSql,
  optionalMillis,
  refreshTokenExpired,
  runSqlSweep,
  type ConnectionRow,
} from './retention.js';

export interface PostgresStorageOptions extends StorageDriverOptions {
  connectionString: string;
}

interface UserRow extends QueryResultRow {
  user_id: string;
  granted_scope: string;
  encrypted_refresh_token: string;
  updated_at: string | number;
  created_at: string | number | null;
}

interface ClientRow extends QueryResultRow {
  client_json: string;
}

interface PendingRow extends QueryResultRow {
  state: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state: string | null;
  scopes: string;
  granted_scope: string;
  expires_at: string | number;
  resource: string | null;
  browser_binding: string | null;
}

interface AuthCodeRow extends QueryResultRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: string | number;
  resource: string | null;
  granted_scope: string | null;
}

interface AccessTokenRow extends QueryResultRow {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string;
  expires_at: string | number;
  resource: string | null;
  granted_scope: string | null;
  family_id: string | null;
}

interface RefreshTokenRow extends QueryResultRow {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string;
  resource: string | null;
  granted_scope: string | null;
  family_id: string | null;
  issued_at: string | number | null;
  family_created_at: string | number | null;
}

interface ConsumedRefreshTokenRow extends QueryResultRow {
  token: string;
  client_id: string;
  family_id: string;
  expires_at: string | number;
}

interface ConsumedAuthCodeRow extends QueryResultRow {
  code: string;
  client_id: string;
  user_id: string | null;
  family_id: string;
  expires_at: string | number;
  revoked: boolean;
}

function userFromRow(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    grantedScope: parseGrantedScope(row.granted_scope),
    encryptedRefreshToken: row.encrypted_refresh_token,
    updatedAt: toMillis(row.updated_at),
    ...(row.created_at !== null ? { createdAt: toMillis(row.created_at) } : {}),
  };
}

function consumedAuthCodeFromRow(row: ConsumedAuthCodeRow): ConsumedAuthCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    userId: row.user_id ?? undefined,
    familyId: row.family_id,
    expiresAt: toMillis(row.expires_at),
    revoked: row.revoked,
  };
}

function authCodeFromRow(row: AuthCodeRow): AuthCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: parseScopes(row.scopes),
    expiresAt: toMillis(row.expires_at),
    resource: row.resource ?? undefined,
    grantedScope: parseOptionalGrantedScope(row.granted_scope),
  };
}

function parseScopes(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === 'string');
}

function refreshTokenFromRow(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    token: row.token,
    clientId: row.client_id,
    userId: row.user_id,
    scopes: parseScopes(row.scopes),
    resource: row.resource ?? undefined,
    grantedScope: parseOptionalGrantedScope(row.granted_scope),
    familyId: row.family_id ?? undefined,
  };
}

const INSERT_ACCESS_TOKEN = `INSERT INTO access_tokens
  (token, client_id, user_id, scopes, expires_at, resource, granted_scope, family_id, issued_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

/** The row for a new access token; `issuedAt` is the storage clock. */
function accessTokenValues(rec: AccessTokenRecord, issuedAt: number): unknown[] {
  return [
    rec.token,
    rec.clientId,
    rec.userId,
    JSON.stringify(rec.scopes),
    rec.expiresAt,
    rec.resource ?? null,
    rec.grantedScope ?? null,
    rec.familyId ?? null,
    issuedAt,
  ];
}

const INSERT_REFRESH_TOKEN = `INSERT INTO refresh_tokens
  (token, client_id, user_id, scopes, resource, granted_scope, family_id, issued_at, family_created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

/** The row for a new refresh token: issued now, in a family created at `familyCreatedAt`. */
function refreshTokenValues(rec: RefreshTokenRecord, issuedAt: number, familyCreatedAt: number): unknown[] {
  return [
    rec.token,
    rec.clientId,
    rec.userId,
    JSON.stringify(rec.scopes),
    rec.resource ?? null,
    rec.grantedScope ?? null,
    rec.familyId ?? null,
    issuedAt,
    familyCreatedAt,
  ];
}

/** Live tokens only: joined to their user under the account-generation invariant. */
const SELECT_ACCESS_TOKEN = `SELECT t.* FROM access_tokens t JOIN users u ON u.user_id = t.user_id
  WHERE t.token = $1 AND ${issuedUnderUserSql('t')}`;
const SELECT_REFRESH_TOKEN = `SELECT t.* FROM refresh_tokens t JOIN users u ON u.user_id = t.user_id
  WHERE t.token = $1 AND ${issuedUnderUserSql('t')}`;

/**
 * Holds the user row against deletion (not against the refresh write-back,
 * which updates a non-key column) until the transaction ends. Every
 * transaction that mints tokens takes it after its family lock and before any
 * token or tombstone row, the order {@link PostgresStorage.deleteUserData}
 * deletes in, so the two serialize on the user row.
 */
const HOLD_USER = 'SELECT created_at FROM users WHERE user_id = $1 FOR KEY SHARE';

function toMillis(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Arbitrary constant key for the schema advisory lock (serializes replicas starting together). */
const SCHEMA_LOCK_KEY = 0x796e6162; // "ynab"

/**
 * First key of the two-key advisory lock that serializes a token family's
 * rotations and its revocation (the second is the family id's hash). The
 * two-key form never collides with the one-key {@link SCHEMA_LOCK_KEY}; two
 * families whose ids hash alike just serialize with each other.
 */
const FAMILY_LOCK_SPACE = 0x666d6c79; // "fmly"

/** Takes the family lock (`$1` = family id) until the transaction ends. */
export const LOCK_FAMILY = `SELECT pg_advisory_xact_lock(${FAMILY_LOCK_SPACE}, hashtext($1))`;

/** One-key session advisory lock held by a running {@link PostgresStorage.sweepExpired}. */
export const SWEEP_LOCK_KEY = 0x73776570; // "swep"

/** The migration transaction's handle on one pooled connection. */
function pgTx(client: PoolClient): MigrationTx {
  return {
    dialect: 'postgres',
    async exec(sql, params) {
      await client.query(sql, params ? [...params] : undefined);
    },
    async query<T extends object>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const res = await client.query<T & QueryResultRow>(sql, params ? [...params] : undefined);
      return res.rows;
    },
    async addColumnIfMissing(table, column, sqlType) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${sqlType}`);
    },
  };
}

/**
 * Create the base (0.3.x) tables, then apply the shared migrations
 * ({@link applyMigrations}), in one transaction under an advisory lock so
 * concurrent replicas don't race. Postgres DDL is transactional, so a failure
 * (including a refusal because a newer release migrated the database) leaves
 * the schema unchanged.
 */
async function migrate(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    // Captured once, after the lock is held, so a replica that waited stamps when it really ran.
    const now = Date.now();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        granted_scope TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_auth (
        state TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        client_state TEXT,
        scopes TEXT NOT NULL,
        granted_scope TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes TEXT NOT NULL
      );
      -- 0.4.0
      CREATE TABLE IF NOT EXISTS consumed_refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
    `);
    await applyMigrations(pgTx(client), now);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export class PostgresStorage implements Storage {
  private pool: PgPool | undefined;
  private readonly retention: RetentionPolicy;

  constructor(private readonly options: PostgresStorageOptions) {
    this.retention = retentionPolicy(options.retention);
  }

  private get db(): PgPool {
    if (!this.pool) throw new Error('PostgresStorage used before init()');
    return this.pool;
  }

  async init(): Promise<void> {
    let Pool: typeof PgPool;
    try {
      const mod = await import('pg');
      // `pg` is a CommonJS module; the Pool constructor lives on the default export.
      Pool = mod.default.Pool;
    } catch {
      throw new Error('Postgres driver selected but pg is not installed');
    }

    const pool = new Pool({ connectionString: this.options.connectionString });

    try {
      await migrate(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }

    this.pool = pool;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }


  // Users + YNAB tokens

  async upsertUser(rec: UserRecord): Promise<void> {
    // created_at is written by the insert only (the account's generation), from
    // the storage clock that also stamps issued_at.
    await this.db.query(
      `INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         granted_scope = EXCLUDED.granted_scope,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         updated_at = EXCLUDED.updated_at`,
      [rec.userId, rec.grantedScope, rec.encryptedRefreshToken, rec.updatedAt, Date.now()]
    );
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const res = await this.db.query<UserRow>('SELECT * FROM users WHERE user_id = $1', [userId]);
    const row = res.rows[0];
    return row ? userFromRow(row) : undefined;
  }

  async updateUserRefreshToken(
    userId: string,
    oldCiphertext: string,
    newCiphertext: string
  ): Promise<UserRecord | undefined> {
    // An UPDATE, never an upsert: a refresh that lost to deleteUserData finds no
    // row. It sets only the token, so a re-consent's access level is kept, and
    // RETURNING hands back the level as stored.
    const res = await this.db.query<UserRow>(
      `UPDATE users SET encrypted_refresh_token = $1, updated_at = $2
       WHERE user_id = $3 AND encrypted_refresh_token = $4 RETURNING *`,
      [newCiphertext, Date.now(), userId, oldCiphertext]
    );
    const row = res.rows[0];
    return row ? userFromRow(row) : undefined;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM users WHERE user_id = $1', [userId]);
  }

  async deleteUserData(userId: string): Promise<void> {
    await this.inTransaction(async (client) => {
      // The user's family locks, in sorted order (deleteUserData is the only
      // transaction that takes more than one), so a rotation, code exchange or
      // replay of a known family finishes first or runs after.
      const found = await client.query<{ family_id: string }>(
        `SELECT family_id FROM access_tokens WHERE user_id = $1 AND family_id IS NOT NULL
         UNION SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND family_id IS NOT NULL
         UNION SELECT family_id FROM consumed_auth_codes WHERE user_id = $1
         UNION SELECT family_id FROM consumed_refresh_tokens WHERE user_id = $1`,
        [userId]
      );
      const families = found.rows.map((r) => r.family_id).sort();
      for (const familyId of families) await client.query(LOCK_FAMILY, [familyId]);
      // The user row first: a transaction minting tokens holds it FOR KEY SHARE
      // (HOLD_USER), so it either commits before this DELETE (and its tokens,
      // committed by then, are deleted below) or finds the row gone. Codes
      // before code tombstones, so a code spent concurrently has its tombstone
      // committed before that DELETE reads. Token rows before tombstones, as
      // revokeConsumedAuthCode writes them.
      await client.query('DELETE FROM users WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM auth_codes WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM access_tokens WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM consumed_auth_codes WHERE user_id = $1', [userId]);
      // Tombstones written by 0.4.x carry no user: matched by family.
      await client.query(
        'DELETE FROM consumed_refresh_tokens WHERE user_id = $1 OR family_id = ANY($2::text[])',
        [userId, families]
      );
    });
  }

  // Account self-service

  async listConnections(userId: string): Promise<ConnectionRecord[]> {
    const res = await this.db.query<ConnectionRow & QueryResultRow>(
      `SELECT t.family_id, t.client_id, t.granted_scope, t.issued_at, t.family_created_at, c.client_json
       FROM refresh_tokens t JOIN users u ON u.user_id = t.user_id
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.user_id = $1 AND t.family_id IS NOT NULL AND ${issuedUnderUserSql('t')}`,
      [userId]
    );
    return connectionsFromRows(res.rows, this.retention, Date.now());
  }

  async revokeUserFamily(userId: string, familyId: string): Promise<boolean> {
    // user_id is in every WHERE: another user's family is a no-op.
    return this.inTransaction(async (client) => {
      await client.query(LOCK_FAMILY, [familyId]);
      const access = await client.query('DELETE FROM access_tokens WHERE family_id = $1 AND user_id = $2', [
        familyId,
        userId,
      ]);
      const refresh = await client.query('DELETE FROM refresh_tokens WHERE family_id = $1 AND user_id = $2', [
        familyId,
        userId,
      ]);
      const codes = await client.query(
        `UPDATE consumed_auth_codes SET revoked = TRUE
         WHERE family_id = $1 AND user_id = $2 AND NOT revoked`,
        [familyId, userId]
      );
      return (access.rowCount ?? 0) + (refresh.rowCount ?? 0) + (codes.rowCount ?? 0) > 0;
    });
  }

  async deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number> {
    return this.inTransaction(async (client) => {
      const found = await client.query<{ family_id: string }>(
        `SELECT family_id FROM access_tokens WHERE user_id = $1 AND client_id = $2 AND family_id IS NOT NULL
         UNION SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND client_id = $2 AND family_id IS NOT NULL
         UNION SELECT family_id FROM consumed_auth_codes WHERE user_id = $1 AND client_id = $2 AND NOT revoked`,
        [userId, clientId]
      );
      const families = found.rows.map((r) => r.family_id).sort();
      for (const familyId of families) await client.query(LOCK_FAMILY, [familyId]);
      await client.query('DELETE FROM access_tokens WHERE user_id = $1 AND client_id = $2', [userId, clientId]);
      // A pre-0.4.0 refresh token has no family; each counts as one grant.
      const unfamilied = await client.query(
        'DELETE FROM refresh_tokens WHERE user_id = $1 AND client_id = $2 AND family_id IS NULL',
        [userId, clientId]
      );
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1 AND client_id = $2', [userId, clientId]);
      await client.query(
        'UPDATE consumed_auth_codes SET revoked = TRUE WHERE user_id = $1 AND client_id = $2 AND NOT revoked',
        [userId, clientId]
      );
      return families.length + (unfamilied.rowCount ?? 0);
    });
  }

  async sweepExpired(options: SweepOptions = {}): Promise<SweepResult> {
    // A session-level try-lock on a dedicated connection: a second sweeper
    // (another replica) skips instead of queueing. Each batch then runs as its
    // own statement, so no transaction holds a large lock set.
    const client = await this.db.connect();
    let broken: Error | undefined;
    try {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SWEEP_LOCK_KEY,
      ]);
      if (!lock.rows[0]?.locked) return { ran: false, deleted: emptySweepCounts() };
      try {
        const deleted = await runSqlSweep(
          {
            dialect: 'postgres',
            async run(sql, params) {
              return (await client.query(sql, [...params])).rowCount ?? 0;
            },
          },
          options.now ?? Date.now(),
          this.retention,
          options.batchSize
        );
        return { ran: true, deleted };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]).catch((err: unknown) => {
          // A connection that can't unlock is discarded, which releases the lock.
          broken = err instanceof Error ? err : new Error('sweep unlock failed');
        });
      }
    } catch (err) {
      broken = err instanceof Error ? err : new Error('sweep failed');
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /** Run `fn` in a transaction on one pooled connection; rolled back if it throws. */
  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // MCP clients

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const res = await this.db.query<ClientRow>(
      'SELECT client_json FROM oauth_clients WHERE client_id = $1',
      [clientId]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return JSON.parse(row.client_json) as OAuthClientInformationFull;
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    // created_at is written by the insert only.
    await this.db.query(
      `INSERT INTO oauth_clients (client_id, client_json, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE SET client_json = EXCLUDED.client_json`,
      [client.client_id, JSON.stringify(client), Date.now()]
    );
  }

  // Pending federated authorization (one-time)

  async savePendingAuth(rec: PendingAuthRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO pending_auth
         (state, client_id, redirect_uri, code_challenge, client_state, scopes, granted_scope, expires_at, resource, browser_binding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        rec.state,
        rec.clientId,
        rec.redirectUri,
        rec.codeChallenge,
        rec.clientState ?? null,
        JSON.stringify(rec.scopes),
        rec.grantedScope,
        rec.expiresAt,
        rec.resource ?? null,
        rec.browserBinding ?? null,
      ]
    );
  }

  async takePendingAuth(state: string): Promise<PendingAuthRecord | undefined> {
    const res = await this.db.query<PendingRow>(
      'DELETE FROM pending_auth WHERE state = $1 RETURNING *',
      [state]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const expiresAt = toMillis(row.expires_at);
    if (expiresAt < Date.now()) return undefined;
    return {
      state: row.state,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      clientState: row.client_state ?? undefined,
      scopes: parseScopes(row.scopes),
      grantedScope: parseGrantedScope(row.granted_scope),
      expiresAt,
      resource: row.resource ?? undefined,
      browserBinding: row.browser_binding ?? undefined,
    };
  }

  // MCP authorization codes (one-time)

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_codes
         (code, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at, resource, granted_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        rec.code,
        rec.clientId,
        rec.userId,
        rec.redirectUri,
        rec.codeChallenge,
        JSON.stringify(rec.scopes),
        rec.expiresAt,
        rec.resource ?? null,
        rec.grantedScope ?? null,
      ]
    );
  }

  async takeAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
    const res = await this.db.query<AuthCodeRow>(
      'DELETE FROM auth_codes WHERE code = $1 RETURNING *',
      [code]
    );
    const row = res.rows[0];
    if (!row || toMillis(row.expires_at) < Date.now()) return undefined;
    return authCodeFromRow(row);
  }

  async consumeAuthCode(
    code: string,
    consumption: AuthCodeConsumption
  ): Promise<AuthCodeRecord | undefined> {
    const now = Date.now();
    // Pruned on its own first, as in rotateRefreshToken. SKIP LOCKED: concurrent
    // prunes would otherwise lock the same expired rows in different orders and
    // can deadlock; a row another transaction holds is left for a later prune.
    await this.db.query(
      `DELETE FROM consumed_auth_codes WHERE code IN (
         SELECT code FROM consumed_auth_codes WHERE expires_at < $1 FOR UPDATE SKIP LOCKED
       )`,
      [now]
    );
    // One statement, so the take and the tombstone commit together: a
    // concurrent take of the same code blocks on the row lock, then finds the
    // code gone and the tombstone visible. A code is spent once, so its
    // tombstone is never overwritten (DO NOTHING; saveCodeTokens then refuses
    // the family it doesn't name).
    const res = await this.db.query<AuthCodeRow>(
      `WITH taken AS (DELETE FROM auth_codes WHERE code = $1 RETURNING *),
       tombstone AS (
         INSERT INTO consumed_auth_codes (code, client_id, user_id, family_id, expires_at, revoked)
         SELECT code, client_id, user_id, $2::text, $3::bigint, FALSE FROM taken
         WHERE expires_at >= $4::bigint
         ON CONFLICT (code) DO NOTHING
       )
       SELECT * FROM taken`,
      [code, consumption.familyId, consumption.consumedUntil, now]
    );
    const row = res.rows[0];
    if (!row || toMillis(row.expires_at) < now) return undefined;
    return authCodeFromRow(row);
  }

  async getConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined> {
    const res = await this.db.query<ConsumedAuthCodeRow>(
      'SELECT * FROM consumed_auth_codes WHERE code = $1 AND expires_at >= $2',
      [code, Date.now()]
    );
    const row = res.rows[0];
    return row ? consumedAuthCodeFromRow(row) : undefined;
  }

  async revokeConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined> {
    // A tombstone's family never changes, so it can be read before the lock.
    const found = await this.getConsumedAuthCode(code);
    if (!found) return undefined;
    // Under the family lock, so a saveCodeTokens in flight commits first and
    // this DELETE's snapshot (taken after the lock is granted) sees its pair,
    // or it runs after this commits and sees the tombstone revoked. The token
    // tables are written before consumed_auth_codes, the order migrate() locks
    // them in, so a replica starting up can't deadlock with this.
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK_FAMILY, [found.familyId]);
      await client.query(
        `WITH access AS (DELETE FROM access_tokens WHERE family_id = $1)
         DELETE FROM refresh_tokens WHERE family_id = $1`,
        [found.familyId]
      );
      const res = await client.query<ConsumedAuthCodeRow>(
        `UPDATE consumed_auth_codes SET revoked = TRUE
         WHERE code = $1 AND family_id = $2 AND expires_at >= $3 RETURNING *`,
        [code, found.familyId, Date.now()]
      );
      const row = res.rows[0];
      if (!row) {
        // Expired or deleted since the read: nothing to revoke.
        await client.query('ROLLBACK');
        return undefined;
      }
      await client.query('COMMIT');
      return consumedAuthCodeFromRow(row);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async saveCodeTokens(code: string, tokens: CodeTokens): Promise<boolean> {
    // The family lock serializes this with revokeConsumedAuthCode (and
    // deleteTokenFamily). FOR UPDATE also holds the tombstone row, so a
    // transaction that deletes the tombstone and then the user's tokens waits
    // for this pair and then deletes it too.
    // The user row is held (HOLD_USER) before the tombstone, the order
    // deleteUserData deletes in: an erase either waits for this pair and then
    // deletes it, or has already removed the user and this refuses.
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK_FAMILY, [tokens.familyId]);
      const now = Date.now();
      const user = await client.query(HOLD_USER, [tokens.refreshToken.userId]);
      const live =
        user.rowCount === 0
          ? user
          : await client.query(
              `SELECT 1 FROM consumed_auth_codes
               WHERE code = $1 AND family_id = $2 AND NOT revoked AND expires_at >= $3
               FOR UPDATE`,
              [code, tokens.familyId, now]
            );
      if (live.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(INSERT_ACCESS_TOKEN, accessTokenValues(tokens.accessToken, now));
      await client.query(INSERT_REFRESH_TOKEN, refreshTokenValues(tokens.refreshToken, now, now));
      await client.query('UPDATE oauth_clients SET last_authorized_at = $1 WHERE client_id = $2', [
        now,
        tokens.refreshToken.clientId,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // MCP access tokens

  async saveAccessToken(rec: AccessTokenRecord): Promise<void> {
    await this.db.query(INSERT_ACCESS_TOKEN, accessTokenValues(rec, Date.now()));
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const res = await this.db.query<AccessTokenRow>(SELECT_ACCESS_TOKEN, [token]);
    const row = res.rows[0];
    if (!row) return undefined;
    const expiresAt = toMillis(row.expires_at);
    if (expiresAt < Date.now()) {
      await this.db.query('DELETE FROM access_tokens WHERE token = $1', [token]);
      return undefined;
    }
    return {
      token: row.token,
      clientId: row.client_id,
      userId: row.user_id,
      scopes: parseScopes(row.scopes),
      expiresAt,
      resource: row.resource ?? undefined,
      grantedScope: parseOptionalGrantedScope(row.granted_scope),
      familyId: row.family_id ?? undefined,
    };
  }

  async deleteAccessToken(token: string): Promise<void> {
    await this.db.query('DELETE FROM access_tokens WHERE token = $1', [token]);
  }

  // MCP refresh tokens (one-time, rotated on use)

  async saveRefreshToken(rec: RefreshTokenRecord): Promise<void> {
    const now = Date.now();
    await this.db.query(INSERT_REFRESH_TOKEN, refreshTokenValues(rec, now, now));
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const res = await this.db.query<RefreshTokenRow>(SELECT_REFRESH_TOKEN, [token]);
    const row = res.rows[0];
    if (!row) return undefined;
    if (this.refreshExpired(row, Date.now())) {
      // Expired, not reused: the token goes, its family stays.
      await this.db.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
      return undefined;
    }
    return refreshTokenFromRow(row);
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const res = await this.db.query<RefreshTokenRow & { user_created_at: string | number | null; has_user: boolean }>(
      `WITH taken AS (DELETE FROM refresh_tokens WHERE token = $1 RETURNING *)
       SELECT taken.*, u.created_at AS user_created_at, (u.user_id IS NOT NULL) AS has_user
       FROM taken LEFT JOIN users u ON u.user_id = taken.user_id`,
      [token]
    );
    const row = res.rows[0];
    if (!row || !row.has_user) return undefined;
    if (!issuedUnderUser(optionalMillis(row.issued_at), optionalMillis(row.user_created_at))) return undefined;
    return this.refreshExpired(row, Date.now()) ? undefined : refreshTokenFromRow(row);
  }

  private refreshExpired(row: RefreshTokenRow, now: number): boolean {
    return refreshTokenExpired(
      optionalMillis(row.issued_at),
      optionalMillis(row.family_created_at),
      this.retention,
      now
    );
  }

  async deleteRefreshToken(token: string): Promise<void> {
    await this.db.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
  }

  async rotateRefreshToken(
    token: string,
    rotation: RefreshTokenRotation
  ): Promise<RefreshTokenRecord | undefined> {
    // Pruned on its own, before the rotation, so the rotation's transaction holds
    // no tombstone locks and a pruning failure spends nothing.
    await this.db.query('DELETE FROM consumed_refresh_tokens WHERE expires_at < $1', [Date.now()]);
    // A concurrent rotation of the same token blocks on the family lock (or the
    // DELETE's row lock) until this transaction commits, then finds the row
    // gone; by then the tombstone and the new tokens are visible to it. The
    // family lock also keeps deleteTokenFamily from running while the new pair
    // is uncommitted. A 0.3.x token's family is new, so nothing contends.
    //
    // The user row is held (HOLD_USER) before the token row, the order
    // deleteUserData deletes in, so an erase either waits for the new pair and
    // deletes it, or has already removed the user and this refuses. That also
    // covers a 0.3.x token, whose new family no erase could have locked.
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK_FAMILY, [rotation.familyId]);
      const userId = rotation.refreshToken.userId;
      const user = await client.query<{ created_at: string | number | null }>(HOLD_USER, [userId]);
      const res =
        user.rowCount === 0
          ? undefined
          : await client.query<RefreshTokenRow>('DELETE FROM refresh_tokens WHERE token = $1 RETURNING *', [
              token,
            ]);
      const row = res?.rows[0];
      if (!row || row.user_id !== userId) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const now = Date.now();
      const userCreatedAt = optionalMillis(user.rows[0]?.created_at);
      if (!issuedUnderUser(optionalMillis(row.issued_at), userCreatedAt) || this.refreshExpired(row, now)) {
        // Expired, or from an erased account: spent with no tombstone and no new pair.
        await client.query('COMMIT');
        return undefined;
      }
      await client.query(
        `INSERT INTO consumed_refresh_tokens (token, client_id, family_id, expires_at, user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (token) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           family_id = EXCLUDED.family_id,
           expires_at = EXCLUDED.expires_at,
           user_id = EXCLUDED.user_id`,
        [token, row.client_id, rotation.familyId, rotation.consumedUntil, row.user_id]
      );
      // The family's absolute clock carries over (a row a 0.4.x replica wrote has none yet).
      const familyCreatedAt = optionalMillis(row.family_created_at) ?? optionalMillis(row.issued_at) ?? now;
      await client.query(INSERT_ACCESS_TOKEN, accessTokenValues(rotation.accessToken, now));
      await client.query(INSERT_REFRESH_TOKEN, refreshTokenValues(rotation.refreshToken, now, familyCreatedAt));
      await client.query('COMMIT');
      return refreshTokenFromRow(row);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // Consumed refresh tokens (reuse detection)

  async getConsumedRefreshToken(token: string): Promise<ConsumedRefreshTokenRecord | undefined> {
    const res = await this.db.query<ConsumedRefreshTokenRow>(
      'SELECT * FROM consumed_refresh_tokens WHERE token = $1',
      [token]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const expiresAt = toMillis(row.expires_at);
    if (expiresAt < Date.now()) return undefined;
    return { token: row.token, clientId: row.client_id, familyId: row.family_id, expiresAt };
  }

  async deleteTokenFamily(familyId: string): Promise<void> {
    // Under the family lock, so a rotation in flight commits first: the DELETE's
    // snapshot is taken after the lock is granted and sees the pair it saved.
    // (Without it, READ COMMITTED would only re-check the rows it blocked on,
    // the spent token, and miss that pair.) Both deletes in one statement.
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK_FAMILY, [familyId]);
      await client.query(
        `WITH access AS (DELETE FROM access_tokens WHERE family_id = $1)
         DELETE FROM refresh_tokens WHERE family_id = $1`,
        [familyId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
