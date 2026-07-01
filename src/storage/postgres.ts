/**
 * PostgreSQL storage adapter (durable, multi-node).
 *
 * Backed by `pg`, imported lazily so the dependency is only required when this
 * driver is selected. Uses a connection pool with parameterized queries. Scopes
 * arrays and full client objects are stored as JSON TEXT. One-time records (auth
 * codes, refresh tokens, pending auth) are deleted-and-returned atomically via a
 * `DELETE ... RETURNING` statement.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Pool as PgPool, QueryResultRow } from 'pg';
import type {
  Storage,
  UserRecord,
  AuthCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  PendingAuthRecord,
  GrantedScope,
} from './types.js';

export interface PostgresStorageOptions {
  connectionString: string;
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
}

interface AuthCodeRow extends QueryResultRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: string | number;
}

interface AccessTokenRow extends QueryResultRow {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string;
  expires_at: string | number;
}

interface RefreshTokenRow extends QueryResultRow {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string;
}

function parseScopes(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === 'string');
}

function toMillis(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
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

    await pool.query(`
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
    `);

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
      grantedScope: row.granted_scope as GrantedScope,
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
         (state, client_id, redirect_uri, code_challenge, client_state, scopes, granted_scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        rec.state,
        rec.clientId,
        rec.redirectUri,
        rec.codeChallenge,
        rec.clientState ?? null,
        JSON.stringify(rec.scopes),
        rec.grantedScope,
        rec.expiresAt,
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
      grantedScope: row.granted_scope as GrantedScope,
      expiresAt,
    };
  }

  // MCP authorization codes (one-time)

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_codes
         (code, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        rec.code,
        rec.clientId,
        rec.userId,
        rec.redirectUri,
        rec.codeChallenge,
        JSON.stringify(rec.scopes),
        rec.expiresAt,
      ]
    );
  }

  async takeAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
    const res = await this.db.query<AuthCodeRow>(
      'DELETE FROM auth_codes WHERE code = $1 RETURNING *',
      [code]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const expiresAt = toMillis(row.expires_at);
    if (expiresAt < Date.now()) return undefined;
    return {
      code: row.code,
      clientId: row.client_id,
      userId: row.user_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scopes: parseScopes(row.scopes),
      expiresAt,
    };
  }

  // MCP access tokens

  async saveAccessToken(rec: AccessTokenRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [rec.token, rec.clientId, rec.userId, JSON.stringify(rec.scopes), rec.expiresAt]
    );
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
    };
  }

  async deleteAccessToken(token: string): Promise<void> {
    await this.db.query('DELETE FROM access_tokens WHERE token = $1', [token]);
  }

  // MCP refresh tokens (one-time, rotated on use)

  async saveRefreshToken(rec: RefreshTokenRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO refresh_tokens (token, client_id, user_id, scopes)
       VALUES ($1, $2, $3, $4)`,
      [rec.token, rec.clientId, rec.userId, JSON.stringify(rec.scopes)]
    );
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const res = await this.db.query<RefreshTokenRow>(
      'DELETE FROM refresh_tokens WHERE token = $1 RETURNING *',
      [token]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      token: row.token,
      clientId: row.client_id,
      userId: row.user_id,
      scopes: parseScopes(row.scopes),
    };
  }

  async deleteRefreshToken(token: string): Promise<void> {
    await this.db.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
  }
}
