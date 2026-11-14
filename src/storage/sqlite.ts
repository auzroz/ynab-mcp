/**
 * SQLite storage adapter (durable, single-node).
 *
 * Backed by `better-sqlite3`, which is imported lazily so the dependency is only
 * required when this driver is actually selected. Scopes arrays and full client
 * objects are stored as JSON TEXT. One-time records (auth codes, refresh tokens,
 * pending auth) are deleted-and-returned atomically inside a transaction; a
 * refresh-token rotation writes its tombstone and new tokens in that same
 * transaction, as spending a code at the token endpoint writes the code's
 * tombstone.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type BetterSqlite3 from 'better-sqlite3';
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
  OAuthRowStore,
  OAuthRowWrite,
  OAuthRowRecord,
  OAuthModel,
  StagedSignIn,
  CodeSaveOutcome,
  ConsumeOutcome,
} from './types.js';
import { resolveStorageTimeouts } from './timeouts.js';
import { applyMigrations, MIGRATION_PLAN, type MigrationDeps, type MigrationTx } from './migrations.js';
import type { TokenKeyDeriver } from '../auth/token-hash.js';
import { parseGrantedScope, parseOptionalGrantedScope } from '../auth/scope.js';
import { retentionPolicy, type RetentionPolicy } from '../auth/retention-defaults.js';
import {
  CONSUMABLE_MODELS,
  GRANT_TOKEN_MODELS,
  connectionsFromGrantRows,
  plainRowKey,
  signInPayload,
  sortConnections,
  userFromSignIn,
  type GrantConnectionRow,
} from './oauth-rows.js';
import {
  connectionsFromRows,
  optionalMillis,
  issuedUnderUser,
  issuedUnderUserSql,
  refreshTokenExpired,
  runSqlSweep,
  type ConnectionRow,
} from './retention.js';
import { USER_DATA_TABLES, USER_GRANTS_SQL, userDataDeleteParams, userDataDeleteSql } from './user-data.js';

export interface SqliteStorageOptions extends StorageDriverOptions {
  path: string;
  /** Derives the `h1.` keys and pepper fingerprint for migration M3 (#52). Required: M3 refuses to run without it. */
  tokenKeys: TokenKeyDeriver;
}

interface UserRow {
  user_id: string;
  granted_scope: string;
  encrypted_refresh_token: string;
  updated_at: number;
  created_at: number | null;
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
  issued_at: number | null;
  family_created_at: number | null;
}

interface ConsumedRefreshTokenRow {
  token: string;
  client_id: string;
  family_id: string;
  expires_at: number;
}

interface ConsumedAuthCodeRow {
  code: string;
  client_id: string;
  user_id: string | null;
  family_id: string;
  expires_at: number;
  revoked: number;
}

function userFromRow(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    grantedScope: parseGrantedScope(row.granted_scope),
    encryptedRefreshToken: row.encrypted_refresh_token,
    updatedAt: row.updated_at,
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
  };
}

function consumedAuthCodeFromRow(row: ConsumedAuthCodeRow): ConsumedAuthCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    userId: row.user_id ?? undefined,
    familyId: row.family_id,
    expiresAt: row.expires_at,
    revoked: row.revoked !== 0,
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
    expiresAt: row.expires_at,
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

/** The migration transaction's handle on this connection (`$1` placeholders become positional `?`). */
function sqliteTx(db: BetterSqlite3.Database): MigrationTx {
  // Positional `?`: placeholders must appear in parameter order, once each.
  const toSqlite = (sql: string): string => sql.replace(/\$\d+/g, '?');
  return {
    dialect: 'sqlite',
    async exec(sql, params = []) {
      if (params.length === 0) db.exec(sql);
      else db.prepare(toSqlite(sql)).run(...params);
    },
    async query<T extends object>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return db.prepare(toSqlite(sql)).all(...params) as T[];
    },
    async addColumnIfMissing(table, column, sqlType) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
      }
    },
  };
}

/**
 * Create the base (0.3.x) tables, then apply the shared migrations
 * ({@link applyMigrations}), in one IMMEDIATE transaction (write lock taken up
 * front, so two processes opening the same file can't both decide a column is
 * missing). The transaction is managed by hand because a backfill is async;
 * every SQLite call is synchronous, so nothing else can run on this connection
 * in between.
 */
async function migrate(db: BetterSqlite3.Database, baseSchema: string, deps: MigrationDeps): Promise<void> {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Captured once, with the write lock held, so it is when the migration really runs.
    const now = Date.now();
    db.exec(baseSchema);
    await applyMigrations(sqliteTx(db), now, MIGRATION_PLAN, undefined, deps);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the transaction already ended
    }
    throw err;
  }
}

/** `$1`-style placeholders as SQLite's positional `?` (in order, once each). */
const toPositional = (sql: string): string => sql.replace(/\$\d+/g, '?');

/** One `oauth_rows` row as SQLite returns it. */
interface OAuthRowRow {
  key: string;
  model: string;
  payload: string;
  grant_id: string | null;
  account_id: string | null;
  client_id: string | null;
  uid: string | null;
  expires_at: number | null;
  consumed_at: number | null;
  created_at: number;
  authorized_at: number | null;
}

function oauthRowFromRow(row: OAuthRowRow): OAuthRowRecord {
  return {
    key: row.key,
    model: row.model as OAuthModel,
    payload: row.payload,
    grantId: row.grant_id ?? undefined,
    accountId: row.account_id ?? undefined,
    clientId: row.client_id ?? undefined,
    uid: row.uid ?? undefined,
    expiresAt: optionalMillis(row.expires_at),
    consumedAt: optionalMillis(row.consumed_at),
    createdAt: row.created_at,
    authorizedAt: optionalMillis(row.authorized_at),
  };
}

/** The shared row upsert: an update keeps created_at, consumed_at and authorized_at. */
const UPSERT_OAUTH_ROW = `INSERT INTO oauth_rows (key, model, payload, grant_id, account_id, client_id, uid, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET model = excluded.model, payload = excluded.payload,
    grant_id = excluded.grant_id, account_id = excluded.account_id, client_id = excluded.client_id,
    uid = excluded.uid, expires_at = excluded.expires_at`;

/** The grant row a grant-bound row names, for the same account and client. */
const LIVE_GRANT_SQL = `SELECT 1 AS one FROM oauth_rows WHERE key = ? AND model = 'Grant' AND account_id = ? AND client_id = ?`;

/** Live tokens only: joined to their user under the account-generation invariant. */
const SELECT_ACCESS_TOKEN = `SELECT t.* FROM access_tokens t JOIN users u ON u.user_id = t.user_id
  WHERE t.token = ? AND ${issuedUnderUserSql('t')}`;
const SELECT_REFRESH_TOKEN = `SELECT t.* FROM refresh_tokens t JOIN users u ON u.user_id = t.user_id
  WHERE t.token = ? AND ${issuedUnderUserSql('t')}`;

export class SqliteStorage implements Storage, OAuthRowStore {
  private db: BetterSqlite3.Database | undefined;
  private readonly retention: RetentionPolicy;

  constructor(private readonly options: SqliteStorageOptions) {
    this.retention = retentionPolicy(options.retention);
  }

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

    // Explicit, bounded lock waits (the library's own default is 5 s). The wait blocks the event
    // loop, so the request-path value is short; startup holds no request slot and gets a longer
    // one for the migration only (set back below).
    const timeouts = resolveStorageTimeouts(this.options.timeouts);
    const db = new Database(this.options.path, { timeout: timeouts.sqliteMigrationBusyTimeoutMs });
    db.pragma('journal_mode = WAL');

    const baseSchema = `
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
    `;
    try {
      await migrate(db, baseSchema, {
        tokenKeys: this.options.tokenKeys,
        clientSchema: this.options.clientSchema,
      });
      db.pragma(`busy_timeout = ${timeouts.sqliteBusyTimeoutMs}`);
    } catch (err) {
      db.close();
      throw err;
    }

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
    this.putUser(rec);
  }

  /**
   * The users-row write of a completed sign-in (#94): the one place a sign-in
   * writes the user, inside its transaction. `created_at` is `now` on insert,
   * the same instant the sign-in's code is stamped with. The YNAB refresh
   * token's ciphertext is stored exactly as given (#57b binds its AAD to this
   * column). #48 resets the user's refresh lease and shared access token here,
   * and #54's inactive-user erase stamps `last_seen_at` here.
   */
  private applyStagedUser(user: UserRecord, now: number): void {
    this.putUser(user, now);
  }

  /** created_at is written by the insert only (the account's generation). */
  private putUser(rec: UserRecord, now: number = Date.now()): void {
    this.database
      .prepare(
        `INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at, created_at)
         VALUES (@userId, @grantedScope, @encryptedRefreshToken, @updatedAt, @createdAt)
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
        createdAt: now,
      });
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM users WHERE user_id = ?')
      .get(userId) as UserRow | undefined;
    return row ? userFromRow(row) : undefined;
  }

  async updateUserRefreshToken(
    userId: string,
    oldCiphertext: string,
    newCiphertext: string
  ): Promise<UserRecord | undefined> {
    const row = this.database
      .prepare(
        `UPDATE users SET encrypted_refresh_token = ?, updated_at = ?
         WHERE user_id = ? AND encrypted_refresh_token = ? RETURNING *`
      )
      .get(newCiphertext, Date.now(), userId, oldCiphertext) as UserRow | undefined;
    return row ? userFromRow(row) : undefined;
  }

  async deleteUser(userId: string): Promise<void> {
    this.database.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  }

  async deleteUserData(userId: string): Promise<void> {
    const erase = this.database.transaction((u: string): void => {
      const db = this.database;
      const families = (
        db
          .prepare(
            `SELECT family_id FROM access_tokens WHERE user_id = ? AND family_id IS NOT NULL
             UNION SELECT family_id FROM refresh_tokens WHERE user_id = ? AND family_id IS NOT NULL
             UNION SELECT family_id FROM consumed_auth_codes WHERE user_id = ?
             UNION SELECT family_id FROM consumed_refresh_tokens WHERE user_id = ?`
          )
          .all(u, u, u, u) as Array<{ family_id: string }>
      ).map((r) => r.family_id);
      const grants = (db.prepare(toPositional(USER_GRANTS_SQL)).all(u) as Array<{ grant_id: string }>).map(
        (r) => r.grant_id
      );
      // Every table of the catalog, in its order (src/storage/user-data.ts).
      // Tombstones written by 0.4.x carry no user: matched by family; a row
      // under one of the user's grants is matched by grant.
      for (const entry of USER_DATA_TABLES) {
        db.prepare(toPositional(userDataDeleteSql(entry, 'sqlite'))).run(
          ...userDataDeleteParams(entry, 'sqlite', u, { families, grants })
        );
      }
    });
    // IMMEDIATE: one writer at a time, so a rotation or code exchange in
    // another process runs wholly before (and is erased) or after (and finds
    // no user row).
    erase.immediate(userId);
  }

  // Account self-service

  async listConnections(userId: string): Promise<ConnectionRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT t.family_id, t.client_id, t.granted_scope, t.issued_at, t.family_created_at, c.client_json
         FROM refresh_tokens t JOIN users u ON u.user_id = t.user_id
         LEFT JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ? AND t.family_id IS NOT NULL AND ${issuedUnderUserSql('t')}`
      )
      .all(userId) as ConnectionRow[];
    const now = Date.now();
    const grantRows = this.database
      .prepare(
        `SELECT g.grant_id, g.client_id, g.payload AS grant_payload, g.created_at AS grant_created_at,
                c.payload AS client_payload, t.created_at AS token_created_at, t.expires_at AS token_expires_at
         FROM oauth_rows g
         JOIN oauth_rows t ON t.grant_id = g.grant_id AND t.model IN ('AccessToken','RefreshToken')
           AND t.consumed_at IS NULL AND t.expires_at >= ?
         JOIN users u ON u.user_id = t.account_id AND t.created_at >= COALESCE(u.created_at, 0)
         LEFT JOIN oauth_rows c ON c.model = 'Client' AND c.client_id = g.client_id
         WHERE g.model = 'Grant' AND g.account_id = ?`
      )
      .all(now, userId) as GrantConnectionRow[];
    return sortConnections([...connectionsFromRows(rows, this.retention, now), ...connectionsFromGrantRows(grantRows)]);
  }

  async revokeUserFamily(userId: string, familyId: string): Promise<boolean> {
    const revoke = this.database.transaction((u: string, f: string): number => {
      const db = this.database;
      const old =
        db.prepare('DELETE FROM access_tokens WHERE family_id = ? AND user_id = ?').run(f, u).changes +
        db.prepare('DELETE FROM refresh_tokens WHERE family_id = ? AND user_id = ?').run(f, u).changes +
        db
          .prepare('UPDATE consumed_auth_codes SET revoked = 1 WHERE family_id = ? AND user_id = ? AND revoked = 0')
          .run(f, u).changes;
      // The library's grants: only the user's own grant is revoked.
      const owned = db
        .prepare("SELECT 1 AS one FROM oauth_rows WHERE key = ? AND model = 'Grant' AND account_id = ?")
        .get(plainRowKey('Grant', f), u);
      if (!owned) return old;
      return old + db.prepare('DELETE FROM oauth_rows WHERE grant_id = ?').run(f).changes;
    });
    return revoke.immediate(userId, familyId) > 0;
  }

  async deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number> {
    const revoke = this.database.transaction((u: string, c: string): number => {
      const db = this.database;
      const { families } = db
        .prepare(
          `SELECT COUNT(DISTINCT family_id) AS families FROM (
             SELECT family_id FROM access_tokens WHERE user_id = ? AND client_id = ? AND family_id IS NOT NULL
             UNION SELECT family_id FROM refresh_tokens WHERE user_id = ? AND client_id = ? AND family_id IS NOT NULL
             UNION SELECT family_id FROM consumed_auth_codes WHERE user_id = ? AND client_id = ? AND revoked = 0
           )`
        )
        .get(u, c, u, c, u, c) as { families: number };
      db.prepare('DELETE FROM access_tokens WHERE user_id = ? AND client_id = ?').run(u, c);
      // A pre-0.4.0 refresh token has no family; each counts as one grant.
      const unfamilied = db
        .prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND client_id = ? AND family_id IS NULL')
        .run(u, c).changes;
      db.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND client_id = ?').run(u, c);
      db.prepare(
        'UPDATE consumed_auth_codes SET revoked = 1 WHERE user_id = ? AND client_id = ? AND revoked = 0'
      ).run(u, c);
      const grants = (
        db
          .prepare("SELECT grant_id FROM oauth_rows WHERE model = 'Grant' AND account_id = ? AND client_id = ?")
          .all(u, c) as Array<{ grant_id: string | null }>
      )
        .map((r) => r.grant_id)
        .filter((g): g is string => g !== null);
      if (grants.length > 0) {
        db.prepare('DELETE FROM oauth_rows WHERE grant_id IN (SELECT value FROM json_each(?))').run(
          JSON.stringify(grants)
        );
      }
      return families + unfamilied + grants.length;
    });
    return revoke.immediate(userId, clientId);
  }

  // oidc-provider rows (OAuthRowStore, ADR-0002 D4). Every write runs in an
  // IMMEDIATE transaction: one writer at a time, so each check and the writes
  // after it are one step against other processes sharing the file.

  private oauthRowParams(row: OAuthRowWrite, createdAt: number): unknown[] {
    return [
      row.key,
      row.model,
      row.payload,
      row.grantId ?? null,
      row.accountId ?? null,
      row.clientId ?? null,
      row.uid ?? null,
      row.expiresAt ?? null,
      createdAt,
    ];
  }

  async upsertOAuthRow(row: OAuthRowWrite): Promise<void> {
    if (GRANT_TOKEN_MODELS.has(row.model) || row.model === 'SignIn') {
      throw new Error(`upsertOAuthRow cannot write a ${row.model} row`);
    }
    const now = Date.now();
    this.database
      .transaction((): void => {
        this.database.prepare(UPSERT_OAUTH_ROW).run(...this.oauthRowParams(row, now));
      })
      .immediate();
  }

  /** The grant row a grant-bound row names exists for the same account and client. */
  private liveGrantFor(row: OAuthRowWrite): boolean {
    if (row.grantId === undefined || row.accountId === undefined || row.clientId === undefined) return false;
    return (
      this.database.prepare(LIVE_GRANT_SQL).get(plainRowKey('Grant', row.grantId), row.accountId, row.clientId) !==
      undefined
    );
  }

  async saveGrantToken(row: OAuthRowWrite): Promise<boolean> {
    if (row.model !== 'AccessToken' && row.model !== 'RefreshToken') {
      throw new Error(`saveGrantToken cannot write a ${row.model} row`);
    }
    const now = Date.now();
    return this.database
      .transaction((): boolean => {
        if (row.accountId === undefined) return false;
        const user = this.database.prepare('SELECT 1 AS one FROM users WHERE user_id = ?').get(row.accountId);
        if (!user || !this.liveGrantFor(row)) return false;
        this.database.prepare(UPSERT_OAUTH_ROW).run(...this.oauthRowParams(row, now));
        return true;
      })
      .immediate();
  }

  async saveAuthorizationCode(row: OAuthRowWrite): Promise<CodeSaveOutcome> {
    if (row.model !== 'AuthorizationCode') throw new Error(`saveAuthorizationCode cannot write a ${row.model} row`);
    const now = Date.now();
    return this.database
      .transaction((): CodeSaveOutcome => {
        const db = this.database;
        // Every check runs before the first write, so a refusal leaves the
        // client's authorized_at unchanged (the transaction holds the write lock throughout).
        const clientKey = row.clientId === undefined ? undefined : plainRowKey('Client', row.clientId);
        if (clientKey === undefined) return 'client-gone';
        const client = db.prepare("SELECT 1 AS one FROM oauth_rows WHERE key = ? AND model = 'Client'").get(clientKey);
        if (!client) return 'client-gone';
        if (!this.liveGrantFor(row) || row.grantId === undefined || row.accountId === undefined) return 'grant-gone';
        const signInKey = plainRowKey('SignIn', row.grantId);
        const signIn = db
          .prepare(
            "SELECT payload FROM oauth_rows WHERE key = ? AND model = 'SignIn' AND account_id = ? AND expires_at >= ?"
          )
          .get(signInKey, row.accountId, now) as { payload: string } | undefined;
        const user = signIn && userFromSignIn(row.accountId, signIn.payload);
        if (!user) return 'no-sign-in';
        db.prepare('UPDATE oauth_rows SET authorized_at = ? WHERE key = ?').run(now, clientKey);
        this.applyStagedUser(user, now);
        db.prepare('DELETE FROM oauth_rows WHERE key = ?').run(signInKey);
        db.prepare(UPSERT_OAUTH_ROW).run(...this.oauthRowParams(row, now));
        return 'saved';
      })
      .immediate();
  }

  async stageSignIn(signIn: StagedSignIn): Promise<boolean> {
    const now = Date.now();
    return this.database
      .transaction((): boolean => {
        const db = this.database;
        const grant = db
          .prepare("SELECT client_id FROM oauth_rows WHERE key = ? AND model = 'Grant' AND account_id = ?")
          .get(plainRowKey('Grant', signIn.grantId), signIn.user.userId) as { client_id: string | null } | undefined;
        if (!grant) return false;
        const key = plainRowKey('SignIn', signIn.grantId);
        db.prepare('DELETE FROM oauth_rows WHERE key = ?').run(key);
        db.prepare(UPSERT_OAUTH_ROW).run(
          ...this.oauthRowParams(
            {
              key,
              model: 'SignIn',
              payload: signInPayload(signIn.user),
              grantId: signIn.grantId,
              accountId: signIn.user.userId,
              clientId: grant.client_id ?? undefined,
              uid: undefined,
              expiresAt: signIn.expiresAt,
            },
            now
          )
        );
        return true;
      })
      .immediate();
  }

  async findOAuthRow(key: string): Promise<OAuthRowRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT r.* FROM oauth_rows r WHERE r.key = ?
           AND (r.model NOT IN ('AccessToken','RefreshToken','AuthorizationCode')
             OR (EXISTS (SELECT 1 FROM oauth_rows g WHERE g.grant_id = r.grant_id AND g.model = 'Grant')
                 AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = r.account_id
                             AND r.created_at >= COALESCE(u.created_at, 0))))`
      )
      .get(key) as OAuthRowRow | undefined;
    return row && oauthRowFromRow(row);
  }

  async findOAuthRowByUid(uid: string): Promise<OAuthRowRecord | undefined> {
    const row = this.database
      .prepare("SELECT * FROM oauth_rows WHERE uid = ? AND model = 'Session' ORDER BY created_at DESC LIMIT 1")
      .get(uid) as OAuthRowRow | undefined;
    return row && oauthRowFromRow(row);
  }

  async consumeOAuthRow(key: string): Promise<ConsumeOutcome> {
    const now = Date.now();
    return this.database
      .transaction((): ConsumeOutcome => {
        const db = this.database;
        const won = db
          .prepare(
            `UPDATE oauth_rows SET consumed_at = ?
             WHERE key = ? AND consumed_at IS NULL AND model IN ('RefreshToken','AuthorizationCode')`
          )
          .run(now, key);
        if (won.changes === 1) return 'consumed';
        const row = db.prepare('SELECT model, grant_id FROM oauth_rows WHERE key = ?').get(key) as
          | { model: OAuthModel; grant_id: string | null }
          | undefined;
        if (!row) return 'missing';
        if (!CONSUMABLE_MODELS.has(row.model)) throw new Error(`consumeOAuthRow cannot consume a ${row.model} row`);
        // Lost the compare-and-set: someone consumed it first. That is reuse.
        if (row.grant_id !== null) db.prepare('DELETE FROM oauth_rows WHERE grant_id = ?').run(row.grant_id);
        else db.prepare('DELETE FROM oauth_rows WHERE key = ?').run(key);
        return 'replayed';
      })
      .immediate();
  }

  async destroyOAuthRow(key: string): Promise<void> {
    this.database
      .transaction((): void => {
        this.database.prepare('DELETE FROM oauth_rows WHERE key = ?').run(key);
      })
      .immediate();
  }

  async revokeOAuthGrant(grantId: string): Promise<number> {
    return this.database
      .transaction((): number => this.database.prepare('DELETE FROM oauth_rows WHERE grant_id = ?').run(grantId).changes)
      .immediate();
  }

  async sweepExpired(options: SweepOptions = {}): Promise<SweepResult> {
    const db = this.database;
    // Each batch is its own statement, so its own short write transaction.
    const deleted = await runSqlSweep(
      {
        dialect: 'sqlite',
        async run(sql, params) {
          return db.prepare(sql.replace(/\$\d+/g, '?')).run(...params).changes;
        },
      },
      options.now ?? Date.now(),
      this.retention,
      options.batchSize
    );
    return { ran: true, deleted };
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
    // created_at is written by the insert only.
    this.database
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_json, created_at)
         VALUES (@clientId, @clientJson, @createdAt)
         ON CONFLICT(client_id) DO UPDATE SET client_json = excluded.client_json`
      )
      .run({ clientId: client.client_id, clientJson: JSON.stringify(client), createdAt: Date.now() });
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
      if (row) {
        this.database.prepare('DELETE FROM pending_auth WHERE state = ?').run(s);
        // In the same transaction: the client is mid-authorization (see sweepExpired).
        this.database
          .prepare('UPDATE oauth_clients SET last_seen_at = ? WHERE client_id = ?')
          .run(Date.now(), row.client_id);
      }
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
      grantedScope: parseGrantedScope(row.granted_scope),
      expiresAt: row.expires_at,
      resource: row.resource ?? undefined,
      browserBinding: row.browser_binding ?? undefined,
    };
  }

  // MCP authorization codes (one-time)

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    this.insertAuthCode(rec);
  }

  private insertAuthCode(rec: AuthCodeRecord): void {
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

  async completeAuthorization(input: { user: UserRecord; code: AuthCodeRecord }): Promise<boolean> {
    // IMMEDIATE takes the write lock first, so the client check and both writes
    // are one step against the sweep and other processes sharing the file.
    const complete = this.database.transaction((i: { user: UserRecord; code: AuthCodeRecord }): boolean => {
      const seen = this.database
        .prepare('UPDATE oauth_clients SET last_seen_at = ? WHERE client_id = ?')
        .run(Date.now(), i.code.clientId);
      if (seen.changes === 0) return false;
      this.applyStagedUser(i.user, Date.now());
      this.insertAuthCode(i.code);
      return true;
    });
    return complete.immediate(input);
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
    return authCodeFromRow(row);
  }

  async consumeAuthCode(
    code: string,
    consumption: AuthCodeConsumption
  ): Promise<AuthCodeRecord | undefined> {
    const now = Date.now();
    const consume = this.database.transaction((c: string): AuthCodeRow | undefined => {
      this.database.prepare('DELETE FROM consumed_auth_codes WHERE expires_at < ?').run(now);
      const row = this.database.prepare('SELECT * FROM auth_codes WHERE code = ?').get(c) as
        | AuthCodeRow
        | undefined;
      if (!row) return undefined;
      this.database.prepare('DELETE FROM auth_codes WHERE code = ?').run(c);
      if (row.expires_at < now) return undefined;
      // A code is spent once, so its tombstone is never overwritten.
      this.database
        .prepare(
          `INSERT OR IGNORE INTO consumed_auth_codes (code, client_id, user_id, family_id, expires_at, revoked)
           VALUES (@code, @clientId, @userId, @familyId, @expiresAt, 0)`
        )
        .run({
          code: c,
          clientId: row.client_id,
          userId: row.user_id,
          familyId: consumption.familyId,
          expiresAt: consumption.consumedUntil,
        });
      return row;
    });
    // IMMEDIATE, as in rotateRefreshToken: another process spending the same
    // code waits for the write lock and then finds the code gone and its
    // tombstone in place.
    const row = consume.immediate(code);
    return row ? authCodeFromRow(row) : undefined;
  }

  async getConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM consumed_auth_codes WHERE code = ?')
      .get(code) as ConsumedAuthCodeRow | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    return consumedAuthCodeFromRow(row);
  }

  async revokeConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined> {
    // A plain read first, as on Postgres, so an unknown code at /token never
    // takes the write lock. Safe because a tombstone's family never changes
    // and the UPDATE below re-checks the row under the lock.
    if (!(await this.getConsumedAuthCode(code))) return undefined;
    const revoke = this.database.transaction((c: string): ConsumedAuthCodeRow | undefined => {
      const row = this.database
        .prepare('UPDATE consumed_auth_codes SET revoked = 1 WHERE code = ? AND expires_at >= ? RETURNING *')
        .get(c, Date.now()) as ConsumedAuthCodeRow | undefined;
      if (!row) return undefined;
      this.database.prepare('DELETE FROM access_tokens WHERE family_id = ?').run(row.family_id);
      this.database.prepare('DELETE FROM refresh_tokens WHERE family_id = ?').run(row.family_id);
      return row;
    });
    // IMMEDIATE: the write lock is the family lock here; saveCodeTokens takes
    // it too, so the two never interleave across processes.
    const row = revoke.immediate(code);
    return row ? consumedAuthCodeFromRow(row) : undefined;
  }

  async saveCodeTokens(code: string, tokens: CodeTokens): Promise<boolean> {
    const save = this.database.transaction((c: string): boolean => {
      const now = Date.now();
      const user = this.database
        .prepare('SELECT 1 FROM users WHERE user_id = ?')
        .get(tokens.refreshToken.userId);
      if (!user) return false;
      const live = this.database
        .prepare(
          `SELECT 1 FROM consumed_auth_codes
           WHERE code = ? AND family_id = ? AND revoked = 0 AND expires_at >= ?`
        )
        .get(c, tokens.familyId, now);
      if (!live) return false;
      this.insertAccessToken(tokens.accessToken, now);
      this.insertRefreshToken(tokens.refreshToken, now, now);
      this.database
        .prepare('UPDATE oauth_clients SET last_authorized_at = ? WHERE client_id = ?')
        .run(now, tokens.refreshToken.clientId);
      return true;
    });
    // IMMEDIATE takes the write lock before the check, so a replay's revocation
    // in another process either committed before it (and the check fails) or
    // waits until the pair is saved (and then deletes it).
    return save.immediate(code);
  }

  // MCP access tokens

  async saveAccessToken(rec: AccessTokenRecord): Promise<void> {
    this.insertAccessToken(rec, Date.now());
  }

  private insertAccessToken(rec: AccessTokenRecord, issuedAt: number): void {
    this.database
      .prepare(
        `INSERT INTO access_tokens (token, client_id, user_id, scopes, expires_at, resource, granted_scope, family_id, issued_at)
         VALUES (@token, @clientId, @userId, @scopes, @expiresAt, @resource, @grantedScope, @familyId, @issuedAt)`
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
        issuedAt,
      });
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const row = this.database.prepare(SELECT_ACCESS_TOKEN).get(token) as AccessTokenRow | undefined;
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
      grantedScope: parseOptionalGrantedScope(row.granted_scope),
      familyId: row.family_id ?? undefined,
    };
  }

  async deleteAccessToken(token: string): Promise<void> {
    this.database.prepare('DELETE FROM access_tokens WHERE token = ?').run(token);
  }

  // MCP refresh tokens (one-time, rotated on use)

  async saveRefreshToken(rec: RefreshTokenRecord): Promise<void> {
    const now = Date.now();
    this.insertRefreshToken(rec, now, now);
  }

  private insertRefreshToken(rec: RefreshTokenRecord, issuedAt: number, familyCreatedAt: number): void {
    this.database
      .prepare(
        `INSERT INTO refresh_tokens
           (token, client_id, user_id, scopes, resource, granted_scope, family_id, issued_at, family_created_at)
         VALUES (@token, @clientId, @userId, @scopes, @resource, @grantedScope, @familyId, @issuedAt, @familyCreatedAt)`
      )
      .run({
        token: rec.token,
        clientId: rec.clientId,
        userId: rec.userId,
        scopes: JSON.stringify(rec.scopes),
        resource: rec.resource ?? null,
        grantedScope: rec.grantedScope ?? null,
        familyId: rec.familyId ?? null,
        issuedAt,
        familyCreatedAt,
      });
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const row = this.database.prepare(SELECT_REFRESH_TOKEN).get(token) as RefreshTokenRow | undefined;
    if (!row) return undefined;
    if (this.refreshExpired(row, Date.now())) {
      // Expired, not reused: the token goes, its family stays.
      this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(token);
      return undefined;
    }
    return refreshTokenFromRow(row);
  }

  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const take = this.database.transaction((t: string): RefreshTokenRow | undefined => {
      const row = this.database.prepare(SELECT_REFRESH_TOKEN).get(t) as RefreshTokenRow | undefined;
      this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(t);
      return row;
    });
    const row = take.immediate(token); // as in rotateRefreshToken
    return row && !this.refreshExpired(row, Date.now()) ? refreshTokenFromRow(row) : undefined;
  }

  private refreshExpired(row: RefreshTokenRow, now: number): boolean {
    return refreshTokenExpired(row.issued_at, row.family_created_at, this.retention, now);
  }

  async deleteRefreshToken(token: string): Promise<void> {
    this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(token);
  }

  async rotateRefreshToken(
    token: string,
    rotation: RefreshTokenRotation
  ): Promise<RefreshTokenRecord | undefined> {
    const rotate = this.database.transaction((t: string): RefreshTokenRow | undefined => {
      const userId = rotation.refreshToken.userId;
      const user = this.database.prepare('SELECT created_at FROM users WHERE user_id = ?').get(userId) as
        | { created_at: number | null }
        | undefined;
      if (!user) return undefined;
      const row = this.database.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(t) as
        | RefreshTokenRow
        | undefined;
      if (!row || row.user_id !== userId) return undefined;
      this.database.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(t);
      const now = Date.now();
      // Expired, or from an erased account: spent with no tombstone and no new pair.
      if (!issuedUnderUser(row.issued_at, user.created_at) || this.refreshExpired(row, now)) return undefined;
      this.database.prepare('DELETE FROM consumed_refresh_tokens WHERE expires_at < ?').run(now);
      this.database
        .prepare(
          `INSERT OR REPLACE INTO consumed_refresh_tokens (token, client_id, family_id, expires_at, user_id)
           VALUES (@token, @clientId, @familyId, @expiresAt, @userId)`
        )
        .run({
          token: t,
          clientId: row.client_id,
          familyId: rotation.familyId,
          expiresAt: rotation.consumedUntil,
          userId: row.user_id,
        });
      this.insertAccessToken(rotation.accessToken, now);
      // The family's absolute clock carries over (a row a 0.4.x replica wrote has none yet).
      this.insertRefreshToken(rotation.refreshToken, now, row.family_created_at ?? row.issued_at ?? now);
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
