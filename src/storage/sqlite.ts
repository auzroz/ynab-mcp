/**
 * SQLite storage adapter (durable, single-node).
 *
 * Backed by `better-sqlite3`, which is imported lazily so the dependency is only
 * required when this driver is actually selected. Scopes arrays and full client
 * objects are stored as JSON TEXT. One-time records (auth codes, refresh tokens,
 * pending auth) are deleted-and-returned atomically inside a transaction; a
 * refresh-token rotation writes its tombstone and new tokens in that same
 * transaction.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  Storage,
  UserRecord,
  AuthCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  RefreshTokenRotation,
  ConsumedRefreshTokenRecord,
  PendingAuthRecord,
  GrantedScope,
} from './types.js';
import { ADDED_COLUMNS, ADDED_INDEXES } from './migrations.js';

export interface SqliteStorageOptions {
  path: string;
}

interface UserRow {
  user_id: string;
  granted_scope: string;
  encrypted_refresh_token: string;
  updated_at: number;
}

interface ClientRow {
  client_id: string;
  client_json: string;
}

interface PendingRow {
  state: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state: string | null;
  scopes: string;
  granted_scope: string;
  expires_at: number;
  resource: string | null;
  browser_binding: string | null;
}

interface AuthCodeRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: number;
  resource: string | null;
  granted_scope: string | null;
}

interface AccessTokenRow {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string;
  expires_at: number;
  resource: string | null;
  granted_scope: string | null;
  family_id: string | null;
}

interface RefreshTokenRow {
  token: string;
  client_id: string;
  user_id: string;
  scopes: string;
  resource: string | null;
  granted_scope: string | null;
  family_id: string | null;
}

interface ConsumedRefreshTokenRow {
  token: string;
  client_id: string;
  family_id: string;
  expires_at: number;
}

function parseScopes(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === 'string');
}

/** A per-grant access level column; NULL (pre-0.4.0) or anything unknown reads as undefined. */
function parseGrantedScope(value: string | null): GrantedScope | undefined {
  return value === 'read-only' || value === 'read-write' ? value : undefined;
}

function refreshTokenFromRow(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    token: row.token,
    clientId: row.client_id,
    userId: row.user_id,
    scopes: parseScopes(row.scopes),
    resource: row.resource ?? undefined,
    grantedScope: parseGrantedScope(row.granted_scope),
    familyId: row.family_id ?? undefined,
  };
}

/**
 * Apply {@link ADDED_COLUMNS} that are not present yet and create
 * {@link ADDED_INDEXES}, in one IMMEDIATE transaction (write lock taken up
 * front, so two processes opening the same file can't both decide a column is
 * missing).
 */
function migrate(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    for (const { table, column, type } of ADDED_COLUMNS) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    for (const { name, table, column } of ADDED_INDEXES) {
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${column})`);
    }
  }).immediate();
}

export class SqliteStorage implements Storage {
  private db: BetterSqlite3.Database | undefined;

  constructor(private readonly options: SqliteStorageOptions) {}

  private get database(): BetterSqlite3.Database {
    if (!this.db) throw new Error('SqliteStorage used before init()');
    return this.db;
  }

  async init(): Promise<void> {
    let Database: typeof BetterSqlite3;
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default;
    } catch {
      throw new Error('SQLite driver selected but better-sqlite3 is not installed');
    }

    const db = new Database(this.options.path);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        granted_scope TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        updated_at INTEGER NOT NULL
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
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL
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
        expires_at INTEGER NOT NULL
      );
    `);
    migrate(db);

    this.db = db;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  // Users + YNAB tokens

  async upsertUser(rec: UserRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at)
         VALUES (@userId, @grantedScope, @encryptedRefreshToken, @updatedAt)
         ON CONFLICT(user_id) DO UPDATE SET
           granted_scope = excluded.granted_scope,
           encrypted_refresh_token = excluded.encrypted_refresh_token,
           updated_at = excluded.updated_at`
      )
      .run({
        userId: rec.userId,
        grantedScope: rec.grantedScope,
        encryptedRefreshToken: rec.encryptedRefreshToken,
        updatedAt: rec.updatedAt,
      });
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM users WHERE user_id = ?')
      .get(userId) as UserRow | undefined;
    if (!row) return undefined;
    return {
      userId: row.user_id,
      grantedScope: row.granted_scope as GrantedScope,
      encryptedRefreshToken: row.encrypted_refresh_token,
      updatedAt: row.updated_at,
    };
  }

  async deleteUser(userId: string): Promise<void> {
    this.database.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  }

  // MCP clients

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = this.database
      .prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as ClientRow | undefined;
    if (!row) return undefined;
    return JSON.parse(row.client_json) as OAuthClientInformationFull;
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_json)
         VALUES (@clientId, @clientJson)
         ON CONFLICT(client_id) DO UPDATE SET client_json = excluded.client_json`
      )
      .run({ clientId: client.client_id, clientJson: JSON.stringify(client) });
  }

  // Pending federated authorization (one-time)

  async savePendingAuth(rec: PendingAuthRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO pending_auth
           (state, client_id, redirect_uri, code_challenge, client_state, scopes, granted_scope, expires_at, resource, browser_binding)
         VALUES (@state, @clientId, @redirectUri, @codeChallenge, @clientState, @scopes, @grantedScope, @expiresAt, @resource, @browserBinding)`
      )
      .run({
        state: rec.state,
        clientId: rec.clientId,
        redirectUri: rec.redirectUri,
        codeChallenge: rec.codeChallenge,
        clientState: rec.clientState ?? null,
        scopes: JSON.stringify(rec.scopes),
        grantedScope: rec.grantedScope,
        expiresAt: rec.expiresAt,
        resource: rec.resource ?? null,
        browserBinding: rec.browserBinding ?? null,
      });
  }

  async takePendingAuth(state: string): Promise<PendingAuthRecord | undefined> {
    const take = this.database.transaction((s: string): PendingRow | undefined => {
      const row = this.database.prepare('SELECT * FROM pending_auth WHERE state = ?').get(s) as
        | PendingRow
        | undefined;
      if (row) this.database.prepare('DELETE FROM pending_auth WHERE state = ?').run(s);
      return row;
    });
    const row = take(state);
    if (!row || row.expires_at < Date.now()) return undefined;
    return {
      state: row.state,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      clientState: row.client_state ?? undefined,
      scopes: parseScopes(row.scopes),
      grantedScope: row.granted_scope as GrantedScope,
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
      browserBinding: row.browser_binding ?? undefined,
    };
  }

  // MCP authorization codes (one-time)

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO auth_codes
           (code, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at, resource, granted_scope)
         VALUES (@code, @clientId, @userId, @redirectUri, @codeChallenge, @scopes, @expiresAt, @resource, @grantedScope)`
      )
      .run({
        code: rec.code,
        clientId: rec.clientId,
        userId: rec.userId,
        redirectUri: rec.redirectUri,
        codeChallenge: rec.codeChallenge,
        scopes: JSON.stringify(rec.scopes),
        expiresAt: rec.expiresAt,
        resource: rec.resource ?? null,
        grantedScope: rec.grantedScope ?? null,
      });
  }

  async takeAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
    const take = this.database.transaction((c: string): AuthCodeRow | undefined => {
      const row = this.database.prepare('SELECT * FROM auth_codes WHERE code = ?').get(c) as
        | AuthCodeRow
        | undefined;
      if (row) this.database.prepare('DELETE FROM auth_codes WHERE code = ?').run(c);
      return row;
    });
    const row = take(code);
    if (!row || row.expires_at < Date.now()) return undefined;
    return {
      code: row.code,
      clientId: row.client_id,
      userId: row.user_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scopes: parseScopes(row.scopes),
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
      grantedScope: parseGrantedScope(row.granted_scope),
    };
  }

  // MCP access tokens

  async saveAccessToken(rec: AccessTokenRecord): Promise<void> {
    this.insertAccessToken(rec);
  }

  private insertAccessToken(rec: AccessTokenRecord): void {
    this.database
      .prepare(
        `INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, resource, granted_scope, family_id)
         VALUES (@token, @clientId, @userId, @scopes, @expiresAt, @resource, @grantedScope, @familyId)`
      )
      .run({
        token: rec.token,
        clientId: rec.clientId,
        userId: rec.userId,
        scopes: JSON.stringify(rec.scopes),
        expiresAt: rec.expiresAt,
        resource: rec.resource ?? null,
        grantedScope: rec.grantedScope ?? null,
        familyId: rec.familyId ?? null,
      });
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM access_tokens WHERE token = ?')
      .get(token) as AccessTokenRow | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      this.database.prepare('DELETE FROM access_tokens WHERE token = ?').run(token);
      return undefined;
    }
    return {
      token: row.token,
      clientId: row.client_id,
      userId: row.user_id,
      scopes: parseScopes(row.scopes),
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
      grantedScope: parseGrantedScope(row.granted_scope),
      familyId: row.family_id ?? undefined,
    };
  }

  async deleteAccessToken(token: string): Promise<void> {
    this.database.prepare('DELETE FROM access_tokens WHERE token = ?').run(token);
  }

  // MCP refresh tokens (one-time, rotated on use)

  async saveRefreshToken(rec: RefreshTokenRecord): Promise<void> {
    this.insertRefreshToken(rec);
  }

  private insertRefreshToken(rec: RefreshTokenRecord): void {
    this.database
      .prepare(
        `INSERT INTO refresh_tokens (token, client_id, user_id, scopes, resource, granted_scope, family_id)
         VALUES (@token, @clientId, @userId, @scopes, @resource, @grantedScope, @familyId)`
      )
      .run({
        token: rec.token,
        clientId: rec.clientId,
        userId: rec.userId,
        scopes: JSON.stringify(rec.scopes),
        resource: rec.resource ?? null,
        grantedScope: rec.grantedScope ?? null,
        familyId: rec.familyId ?? null,
      });
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM refresh_tokens WHERE token = ?')
      .get(token) as RefreshTokenRow | undefined;
    return row ? refreshTokenFromRow(row) : undefined;
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const take = this.database.transaction((t: string): RefreshTokenRow | undefined => {
      const row = this.database.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(t) as
        | RefreshTokenRow
        | undefined;
      if (row) this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(t);
      return row;
    });
    const row = take.immediate(token); // as in rotateRefreshToken
    return row ? refreshTokenFromRow(row) : undefined;
  }

  async deleteRefreshToken(token: string): Promise<void> {
    this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(token);
  }

  async rotateRefreshToken(
    token: string,
    rotation: RefreshTokenRotation
  ): Promise<RefreshTokenRecord | undefined> {
    const rotate = this.database.transaction((t: string): RefreshTokenRow | undefined => {
      const row = this.database.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(t) as
        | RefreshTokenRow
        | undefined;
      if (!row) return undefined;
      this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(t);
      this.database.prepare('DELETE FROM consumed_refresh_tokens WHERE expires_at < ?').run(Date.now());
      this.database
        .prepare(
          `INSERT OR REPLACE INTO consumed_refresh_tokens (token, client_id, family_id, expires_at)
           VALUES (@token, @clientId, @familyId, @expiresAt)`
        )
        .run({
          token: t,
          clientId: row.client_id,
          familyId: rotation.familyId,
          expiresAt: rotation.consumedUntil,
        });
      this.insertAccessToken(rotation.accessToken);
      this.insertRefreshToken(rotation.refreshToken);
      return row;
    });
    // IMMEDIATE takes the write lock before the SELECT. A deferred transaction
    // would upgrade its read snapshot at the DELETE, and when another process
    // sharing the file has just rotated the same token that upgrade fails with
    // SQLITE_BUSY_SNAPSHOT (busy_timeout doesn't retry it) instead of waiting
    // and finding the row gone, which skips the reuse response.
    const row = rotate.immediate(token);
    return row ? refreshTokenFromRow(row) : undefined;
  }

  // Consumed refresh tokens (reuse detection)

  async getConsumedRefreshToken(token: string): Promise<ConsumedRefreshTokenRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM consumed_refresh_tokens WHERE token = ?')
      .get(token) as ConsumedRefreshTokenRow | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    return {
      token: row.token,
      clientId: row.client_id,
      familyId: row.family_id,
      expiresAt: row.expires_at,
    };
  }

  async deleteTokenFamily(familyId: string): Promise<void> {
    this.database.transaction((f: string) => {
      this.database.prepare('DELETE FROM access_tokens WHERE family_id = ?').run(f);
      this.database.prepare('DELETE FROM refresh_tokens WHERE family_id = ?').run(f);
    })(familyId);
  }
}
