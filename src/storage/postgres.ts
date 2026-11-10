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
} from './types.js';
import { applyMigrations, MIGRATION_PLAN, type MigrationTx } from './migrations.js';
import type { TokenKeyDeriver } from '../auth/token-hash.js';
import { parseGrantedScope, parseOptionalGrantedScope } from '../auth/scope.js';

export interface PostgresStorageOptions {
  connectionString: string;
  /** Derives the `h1.` keys and pepper fingerprint for migration M3 (#52). Required: M3 refuses to run without it. */
  tokenKeys: TokenKeyDeriver;
}

interface UserRow extends QueryResultRow {
  user_id: string;
  granted_scope: string;
  encrypted_refresh_token: string;
  updated_at: string | number;
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
  (token, client_id, user_id, scopes, expires_at, resource, granted_scope, family_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

function accessTokenValues(rec: AccessTokenRecord): unknown[] {
  return [
    rec.token,
    rec.clientId,
    rec.userId,
    JSON.stringify(rec.scopes),
    rec.expiresAt,
    rec.resource ?? null,
    rec.grantedScope ?? null,
    rec.familyId ?? null,
  ];
}

const INSERT_REFRESH_TOKEN = `INSERT INTO refresh_tokens
  (token, client_id, user_id, scopes, resource, granted_scope, family_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;

function refreshTokenValues(rec: RefreshTokenRecord): unknown[] {
  return [
    rec.token,
    rec.clientId,
    rec.userId,
    JSON.stringify(rec.scopes),
    rec.resource ?? null,
    rec.grantedScope ?? null,
    rec.familyId ?? null,
  ];
}

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
async function migrate(pool: PgPool, tokenKeys: TokenKeyDeriver): Promise<void> {
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
    await applyMigrations(pgTx(client), now, MIGRATION_PLAN, undefined, { tokenKeys });
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

  constructor(private readonly options: PostgresStorageOptions) {}

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
      await migrate(pool, this.options.tokenKeys);
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
    await this.db.query(
      `INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         granted_scope = EXCLUDED.granted_scope,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         updated_at = EXCLUDED.updated_at`,
      [rec.userId, rec.grantedScope, rec.encryptedRefreshToken, rec.updatedAt]
    );
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const res = await this.db.query<UserRow>('SELECT * FROM users WHERE user_id = $1', [userId]);
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      userId: row.user_id,
      grantedScope: parseGrantedScope(row.granted_scope),
      encryptedRefreshToken: row.encrypted_refresh_token,
      updatedAt: toMillis(row.updated_at),
    };
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM users WHERE user_id = $1', [userId]);
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
    await this.db.query(
      `INSERT INTO oauth_clients (client_id, client_json)
       VALUES ($1, $2)
       ON CONFLICT (client_id) DO UPDATE SET client_json = EXCLUDED.client_json`,
      [client.client_id, JSON.stringify(client)]
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
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK_FAMILY, [tokens.familyId]);
      const live = await client.query(
        `SELECT 1 FROM consumed_auth_codes
         WHERE code = $1 AND family_id = $2 AND NOT revoked AND expires_at >= $3
         FOR UPDATE`,
        [code, tokens.familyId, Date.now()]
      );
      if (live.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(INSERT_ACCESS_TOKEN, accessTokenValues(tokens.accessToken));
      await client.query(INSERT_REFRESH_TOKEN, refreshTokenValues(tokens.refreshToken));
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
    await this.db.query(INSERT_ACCESS_TOKEN, accessTokenValues(rec));
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const res = await this.db.query<AccessTokenRow>(
      'SELECT * FROM access_tokens WHERE token = $1',
      [token]
    );
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
    await this.db.query(INSERT_REFRESH_TOKEN, refreshTokenValues(rec));
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const res = await this.db.query<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token = $1',
      [token]
    );
    const row = res.rows[0];
    return row ? refreshTokenFromRow(row) : undefined;
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const res = await this.db.query<RefreshTokenRow>(
      'DELETE FROM refresh_tokens WHERE token = $1 RETURNING *',
      [token]
    );
    const row = res.rows[0];
    return row ? refreshTokenFromRow(row) : undefined;
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
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(LOCK_FAMILY, [rotation.familyId]);
      const res = await client.query<RefreshTokenRow>(
        'DELETE FROM refresh_tokens WHERE token = $1 RETURNING *',
        [token]
      );
      const row = res.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return undefined;
      }
      await client.query(
        `INSERT INTO consumed_refresh_tokens (token, client_id, family_id, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           family_id = EXCLUDED.family_id,
           expires_at = EXCLUDED.expires_at`,
        [token, row.client_id, rotation.familyId, rotation.consumedUntil]
      );
      await client.query(INSERT_ACCESS_TOKEN, accessTokenValues(rotation.accessToken));
      await client.query(INSERT_REFRESH_TOKEN, refreshTokenValues(rotation.refreshToken));
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
