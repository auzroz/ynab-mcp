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

import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type { Client as PgClient, Pool as PgPool, PoolClient, QueryResultRow } from 'pg';
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
  KeyCheckOutcome,
  KeyFloors,
  StoredUserCiphertext,
  RefreshedAccessToken,
  InactiveUserCondition,
} from './types.js';
import {
  CONDITIONAL_RAISE_FLOOR_SQL,
  RAISE_FLOOR_SQL,
  RETIRED_FLOOR_KEY,
  RETIRING_FLOOR_KEY,
  assertFloorAllows,
  compareKeyCheck,
  floorsFromRows,
  keyCheckMetaKey,
  parseRetiredFloor,
  signInCiphertext,
} from './encryption-meta.js';
import { resolveStorageTimeouts, type StorageTimeouts } from './timeouts.js';
import { PostgresSharedLimits, runRateLimitSweep, type RateLimitSweepCounts, type SharedLimitStore } from './shared-limits.js';
import {
  auditCountSql,
  auditInsert,
  auditListSql,
  auditRecordFromRow,
  type AuditGuard,
  type AuditQuery,
  type AuditRecord,
  type AuditRow,
} from './audit-rows.js';
import { applyMigrations, MIGRATION_PLAN, type MigrationDeps, type MigrationTx } from './migrations.js';
import type { TokenKeyDeriver } from '../auth/token-hash.js';
import { parseGrantedScope, parseOptionalGrantedScope } from '../auth/scope.js';
import { retentionPolicy, type RetentionPolicy } from '../auth/retention-defaults.js';
import {
  CONSUMABLE_MODELS,
  GRANT_TOKEN_MODELS,
  connectionsFromGrantRows,
  OTHER_LIVE_GRANTS_SQL,
  otherLiveGrantsParams,
  REJECTED_YNAB_TOKEN_SQL,
  rejectedYnabTokenKey,
  rejectedYnabTokenRow,
  plainRowKey,
  signInKeepsStoredToken,
  signInPayload,
  sortConnections,
  userFromSignIn,
  type GrantConnectionRow,
} from './oauth-rows.js';
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
import {
  USER_DATA_TABLES,
  USER_GRANTS_SQL,
  USER_LIVE_GRANT_SQL,
  userDataDeleteParams,
  userDataDeleteSql,
  userLiveGrantParams,
} from './user-data.js';

export interface PostgresStorageOptions extends StorageDriverOptions {
  connectionString: string;
  /** Derives the `h1.` keys and pepper fingerprint for migration M3 (#52). Required: M3 refuses to run without it. */
  tokenKeys: TokenKeyDeriver;
}

interface UserRow extends QueryResultRow {
  user_id: string;
  granted_scope: string;
  encrypted_refresh_token: string;
  updated_at: string | number;
  created_at: string | number | null;
  encrypted_access_token: string | null;
  access_token_expires_at: string | number | null;
  refresh_lease_until: string | number | null;
  last_seen_at: string | number | null;
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
    ...(row.encrypted_access_token !== null ? { encryptedAccessToken: row.encrypted_access_token } : {}),
    ...(row.access_token_expires_at !== null ? { accessTokenExpiresAt: toMillis(row.access_token_expires_at) } : {}),
    ...(row.refresh_lease_until !== null ? { refreshLeaseUntil: toMillis(row.refresh_lease_until) } : {}),
    ...(row.last_seen_at !== null ? { lastSeenAt: toMillis(row.last_seen_at) } : {}),
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

/**
 * created_at is written by the insert only (the account's generation), from the
 * storage clock that also stamps issued_at. Every write is a sign-in or
 * re-consent: the shared access token and the refresh lease are cleared (#48;
 * the new grant may have another YNAB scope), and `last_seen_at` is stamped
 * (#54e) from the same clock.
 */
const UPSERT_USER_SQL = `INSERT INTO users (user_id, granted_scope, encrypted_refresh_token, updated_at, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         granted_scope = EXCLUDED.granted_scope,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         updated_at = EXCLUDED.updated_at,
         encrypted_access_token = NULL,
         access_token_expires_at = NULL,
         refresh_lease_holder = NULL,
         refresh_lease_until = NULL,
         last_seen_at = EXCLUDED.last_seen_at`;
const upsertUserParams = (rec: UserRecord, now: number = Date.now()): unknown[] => [
  rec.userId,
  rec.grantedScope,
  rec.encryptedRefreshToken,
  rec.updatedAt,
  now,
];

/**
 * The users-row write of a completed sign-in (#94): the one place a sign-in
 * writes the user, inside its transaction. `created_at` is `now` on insert,
 * the same instant the sign-in's code is stamped with. The YNAB refresh
 * token's ciphertext is stored exactly as given (#57b binds its AAD to this
 * column). As every upsert, it resets the user's refresh lease and shared
 * access token (#48) and stamps `last_seen_at` (#54e).
 */
async function applyStagedUser(client: PoolClient, user: UserRecord, now: number): Promise<void> {
  await guardCiphertext(client, user.encryptedRefreshToken);
  await client.query(UPSERT_USER_SQL, upsertUserParams(user, now));
}

/**
 * A completed sign-in's users-row write (#64b), inside saveAuthorizationCode's
 * transaction and after its LOCK_ACCOUNT, so concurrent sign-ins of one user
 * decide one after the other: its YNAB token replaces the stored one, unless
 * signInKeepsStoredToken says to keep a read-write one (never one YNAB
 * refused: a marker for the ciphertext read here), when only
 * `last_seen_at` is stamped (a sign-in is activity, #54e). LOCK_ACCOUNT
 * orders this against every other sign-in of the user. The users row is read
 * FOR NO KEY UPDATE, the lock the write takes anyway, only earlier: a
 * refresh write-back or a rekey (single compare-and-set UPDATEs of that row,
 * outside LOCK_ACCOUNT) either committed first, and its ciphertext is the one
 * decided on, or waits and then misses its compare-and-set when the token
 * was replaced (the sign-in's token wins, as any sign-in during a refresh).
 */
async function applySignIn(client: PoolClient, user: UserRecord, grantId: string, now: number): Promise<void> {
  // Locked as the write below would lock it, so the token decided on is the
  // token replaced or kept (see the comment above).
  const stored = await client.query<{ granted_scope: string | null; encrypted_refresh_token: string }>(
    'SELECT granted_scope, encrypted_refresh_token FROM users WHERE user_id = $1 FOR NO KEY UPDATE',
    [user.userId]
  );
  const row = stored.rows[0];
  if (row) {
    const others = await client.query<{ payload: string }>(
      OTHER_LIVE_GRANTS_SQL,
      otherLiveGrantsParams(user.userId, grantId, now)
    );
    const payloads = others.rows.map((r) => r.payload);
    // The marker for the ciphertext read in this transaction (a newer token never matches).
    const marker = await client.query(REJECTED_YNAB_TOKEN_SQL, [
      rejectedYnabTokenKey(user.userId, row.encrypted_refresh_token),
      user.userId,
    ]);
    const rejected = (marker.rowCount ?? 0) > 0;
    if (signInKeepsStoredToken({ grantedScope: parseGrantedScope(row.granted_scope) }, user, payloads, rejected)) {
      await client.query('UPDATE users SET last_seen_at = $2 WHERE user_id = $1', [user.userId, now]);
      return;
    }
  }
  await applyStagedUser(client, user, now);
}

/**
 * The persistence-time key floor guard (#57b), inside the write's
 * transaction: read the retired floor FOR SHARE and throw KeyRetiredError
 * when `ciphertext` is under a key id below it (not the announced floor: see
 * assertFloorAllows). The retirement takes the
 * retired floor's row FOR UPDATE before its compare-and-set, so either it
 * waits for this transaction (and then sees its users row, and holds back),
 * or this lock waits for the retirement (and then reads the new floor, and
 * refuses). The rows exist from startup (ensureKeyFloorRows).
 */
async function guardCiphertext(client: PoolClient, ciphertext: string): Promise<void> {
  const res = await client.query<{ key: string; value: string }>(
    'SELECT key, value FROM schema_meta WHERE key = $1 FOR SHARE',
    [RETIRED_FLOOR_KEY]
  );
  assertFloorAllows(floorsFromRows(res.rows), ciphertext);
}

const INSERT_AUTH_CODE_SQL = `INSERT INTO auth_codes
         (code, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at, resource, granted_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
const authCodeParams = (rec: AuthCodeRecord): unknown[] => [
  rec.code,
  rec.clientId,
  rec.userId,
  rec.redirectUri,
  rec.codeChallenge,
  JSON.stringify(rec.scopes),
  rec.expiresAt,
  rec.resource ?? null,
  rec.grantedScope ?? null,
];

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

/**
 * First key of the two-key advisory lock that serializes an account's
 * oidc-provider writes with its erasure (the second is the user id's hash).
 * The order is: this lock, then the grants' {@link LOCK_FAMILY} locks (sorted
 * when there are several), then the user row ({@link HOLD_USER}), then rows.
 */
const ACCOUNT_LOCK_SPACE = 0x61636374; // "acct"

/** Takes the account lock (`$1` = user id) until the transaction ends. */
export const LOCK_ACCOUNT = `SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK_SPACE}, hashtext($1))`;

/** One `oauth_rows` row as `pg` returns it (BIGINT columns are strings). */
interface OAuthRowRow {
  key: string;
  model: string;
  payload: string;
  grant_id: string | null;
  account_id: string | null;
  client_id: string | null;
  uid: string | null;
  expires_at: string | number | null;
  consumed_at: string | number | null;
  created_at: string | number;
  authorized_at: string | number | null;
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
    createdAt: toMillis(row.created_at),
    authorizedAt: optionalMillis(row.authorized_at),
  };
}

/** The shared row upsert: an update keeps created_at, consumed_at and authorized_at. */
const UPSERT_OAUTH_ROW = `INSERT INTO oauth_rows (key, model, payload, grant_id, account_id, client_id, uid, expires_at, created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (key) DO UPDATE SET model = EXCLUDED.model, payload = EXCLUDED.payload,
    grant_id = EXCLUDED.grant_id, account_id = EXCLUDED.account_id, client_id = EXCLUDED.client_id,
    uid = EXCLUDED.uid, expires_at = EXCLUDED.expires_at`;

/** compareAndSetOAuthRow: insert while no row has the key (a concurrent insert of the key loses). */
const INSERT_OAUTH_ROW_IF_ABSENT = `INSERT INTO oauth_rows (key, model, payload, grant_id, account_id, client_id, uid, expires_at, created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (key) DO NOTHING`;

/**
 * compareAndSetOAuthRow: replace while the row has the model and exactly the
 * expected payload. A concurrent UPDATE of the row waits for the row lock and
 * re-checks the WHERE on the version it finds, so only one replaces.
 */
const REPLACE_OAUTH_ROW_IF = `UPDATE oauth_rows SET payload = $3, grant_id = $4, account_id = $5, client_id = $6, uid = $7, expires_at = $8
  WHERE key = $1 AND model = $2 AND payload = $9`;

const oauthRowParams = (row: OAuthRowWrite, createdAt: number): unknown[] => [
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

/** The grant row a grant-bound row names, for the same account and client, held against deletion. */
const LIVE_GRANT_SQL = `SELECT 1 FROM oauth_rows WHERE key = $1 AND model = 'Grant' AND account_id = $2 AND client_id = $3 FOR KEY SHARE`;

/** Thrown inside a transaction to roll it back and return `value` from {@link PostgresStorage.refusable}. */
class Refusal<T> {
  constructor(readonly value: T) {}
}

/**
 * First key of the two-key session advisory lock a running
 * {@link PostgresStorage.sweepExpired} holds; the second is
 * `hashtext(current_schema())`, so one schema has one sweeper and schemas
 * sharing a database do not skip each other.
 */
export const SWEEP_LOCK_KEY = 0x73776570; // "swep"

/** The migration transaction's handle on one pooled connection. */
function pgTx(client: PoolClient | PgClient): MigrationTx {
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
async function migrate(client: PgClient, deps: MigrationDeps): Promise<void> {
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
    await applyMigrations(pgTx(client), now, MIGRATION_PLAN, undefined, deps);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** `pg`'s client-side `query_timeout` error. It leaves the query running on the connection. */
function isClientQueryTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'Query read timeout';
}

/**
 * `pg` does not close a connection whose query timed out: it hands the error
 * back and keeps the socket, with the query possibly still running on the
 * server, so the pool would reuse a connection in an unknown state. Once a query
 * on this client times out, every later query fails at once (a ROLLBACK would
 * only queue behind the stuck statement, and the server aborts an open
 * transaction when the socket closes), and `release()` destroys the connection.
 * A write that timed out may still commit; nothing here retries it.
 */
function guardClient(client: PoolClient): PoolClient {
  let timedOut: Error | undefined;
  // pg reuses this client object across checkouts and resets `release` but not `query`,
  // so the original is put back on release; wrappers would otherwise nest per checkout.
  const original = client.query;
  const query = original.bind(client) as (...args: unknown[]) => unknown;
  const release = client.release.bind(client);
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
    if (timedOut) return Promise.reject(timedOut);
    const result = query(...args);
    if (!(result instanceof Promise)) return result;
    return result.catch((err: unknown) => {
      if (isClientQueryTimeout(err)) timedOut = err as Error;
      throw err;
    });
  };
  client.release = (err?: Error | boolean) => {
    client.query = original;
    release(err ?? timedOut);
  };
  return client;
}

/** Connections the shared rate limiter's pool opens at most (#67); its statements are single-row and short. */
export const LIMITER_POOL_MAX = 4;

export class PostgresStorage implements Storage, OAuthRowStore {
  private pool: PgPool | undefined;
  private readonly retention: RetentionPolicy;
  private poolClass: typeof PgPool | undefined;
  private timeouts: StorageTimeouts | undefined;
  /** The shared limiter's pool and store (#67), opened on first use. */
  private limiter: { pool: PgPool; store: PostgresSharedLimits } | undefined;

  constructor(private readonly options: PostgresStorageOptions) {
    this.retention = retentionPolicy(options.retention);
  }

  private get db(): PgPool {
    if (!this.pool) throw new Error('PostgresStorage used before init()');
    return this.pool;
  }

  async init(): Promise<void> {
    let Pool: typeof PgPool;
    let Client: typeof PgClient;
    try {
      const mod = await import('pg');
      // `pg` is a CommonJS module; the Pool constructor lives on the default export.
      Pool = mod.default.Pool;
      Client = mod.default.Client;
    } catch {
      throw new Error('Postgres driver selected but pg is not installed');
    }

    const timeouts = resolveStorageTimeouts(this.options.timeouts);
    const pool = new Pool({
      connectionString: this.options.connectionString,
      // The server cancels a slow statement first; query_timeout (above it) fires only
      // when the server can't be reached, and guardClient() then discards that connection.
      statement_timeout: timeouts.pgStatementTimeoutMs,
      query_timeout: timeouts.pgQueryTimeoutMs,
      connectionTimeoutMillis: timeouts.pgConnectionTimeoutMs,
    });

    // Startup holds no request slot, so the migration runs on its own connection under none of the
    // request-path bounds: it may wait for the schema lock while another replica migrates, or for a
    // lock an older version still serving holds, and a statement_timeout would roll a long backfill
    // back and restart-loop. Only the connect is bounded, so an unreachable database fails startup;
    // TCP keep-alive detects a server that vanishes mid-migration.
    const migration = new Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: timeouts.pgConnectionTimeoutMs,
      keepAlive: true,
    });
    try {
      await migration.connect();
      await migrate(migration, { tokenKeys: this.options.tokenKeys, clientSchema: this.options.clientSchema });
    } catch (err) {
      await migration.end().catch(() => undefined);
      await pool.end();
      throw err;
    }
    await migration.end().catch(() => undefined);

    this.pool = pool;
    this.poolClass = Pool;
    this.timeouts = timeouts;
  }

  async close(): Promise<void> {
    if (this.limiter) {
      const { pool } = this.limiter;
      this.limiter = undefined;
      await pool.end();
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }

  /**
   * The shared rate limiter's store (#67), on a small pool of its own with
   * short time bounds (the `pgLimiter*` timeouts), so a limiter call never
   * queues behind the storage pool and fails within those bounds when the
   * database is slow or gone.
   */
  sharedLimits(): SharedLimitStore {
    if (this.limiter) return this.limiter.store;
    const Pool = this.poolClass;
    const timeouts = this.timeouts;
    if (!Pool || !timeouts) throw new Error('PostgresStorage used before init()');
    const pool = new Pool({
      connectionString: this.options.connectionString,
      max: LIMITER_POOL_MAX,
      statement_timeout: timeouts.pgLimiterStatementTimeoutMs,
      query_timeout: timeouts.pgLimiterQueryTimeoutMs,
      connectionTimeoutMillis: timeouts.pgLimiterConnectionTimeoutMs,
    });
    // An idle connection that dies (the server restarts) is an 'error' on the
    // pool; the next query opens a new one.
    pool.on('error', () => undefined);
    this.limiter = { pool, store: new PostgresSharedLimits(pool) };
    return this.limiter.store;
  }

  async sweepRateLimitRows(): Promise<RateLimitSweepCounts> {
    // The database's clock, as the limiters write with it; `now` is unused here.
    return runRateLimitSweep(
      'postgres',
      async (sql, params) => (await this.db.query(sql, params)).rowCount ?? 0,
      0
    );
  }


  // Users + YNAB tokens

  async upsertUser(rec: UserRecord): Promise<void> {
    await this.inTransaction(async (client) => {
      await guardCiphertext(client, rec.encryptedRefreshToken);
      await client.query(UPSERT_USER_SQL, upsertUserParams(rec));
    });
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const res = await this.db.query<UserRow>('SELECT * FROM users WHERE user_id = $1', [userId]);
    const row = res.rows[0];
    return row ? userFromRow(row) : undefined;
  }

  async updateUserRefreshToken(
    userId: string,
    oldCiphertext: string,
    newCiphertext: string,
    refreshed?: RefreshedAccessToken
  ): Promise<UserRecord | undefined> {
    // An UPDATE, never an upsert: a refresh that lost to deleteUserData finds no
    // row. It sets only the tokens (and, after a refresh, clears the lease and
    // stamps last_seen_at), so a re-consent's access level is kept, and
    // RETURNING hands back the level as stored.
    // The floor read (FOR SHARE) and the write in one short transaction
    // (#57b), on both ciphertexts a refresh writes; the YNAB call is over by now.
    const row = await this.inTransaction(async (client) => {
      await guardCiphertext(client, newCiphertext);
      if (refreshed) await guardCiphertext(client, refreshed.encryptedAccessToken);
      const res = refreshed
        ? await client.query<UserRow>(
            `UPDATE users SET encrypted_refresh_token = $1, updated_at = $2, encrypted_access_token = $3,
               access_token_expires_at = $4, refresh_lease_holder = NULL, refresh_lease_until = NULL, last_seen_at = $2
             WHERE user_id = $5 AND encrypted_refresh_token = $6 RETURNING *`,
            [newCiphertext, refreshed.now, refreshed.encryptedAccessToken, refreshed.expiresAt, userId, oldCiphertext]
          )
        : await client.query<UserRow>(
            `UPDATE users SET encrypted_refresh_token = $1, updated_at = $2
             WHERE user_id = $3 AND encrypted_refresh_token = $4 RETURNING *`,
            [newCiphertext, Date.now(), userId, oldCiphertext]
          );
      return res.rows[0];
    });
    return row ? userFromRow(row) : undefined;
  }

  async claimRefreshLease(userId: string, holder: string, now: number, until: number): Promise<UserRecord | undefined> {
    // One auto-commit statement: Postgres re-checks the WHERE against the row
    // a concurrent claim committed, so of two claims one wins. No transaction
    // or connection is held afterwards.
    const res = await this.db.query<UserRow>(
      `UPDATE users SET refresh_lease_holder = $1, refresh_lease_until = $2
       WHERE user_id = $3 AND (refresh_lease_until IS NULL OR refresh_lease_until <= $4) RETURNING *`,
      [holder, until, userId, now]
    );
    const row = res.rows[0];
    return row ? userFromRow(row) : undefined;
  }

  async releaseRefreshLease(userId: string, holder: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET refresh_lease_holder = NULL, refresh_lease_until = NULL
       WHERE user_id = $1 AND refresh_lease_holder = $2`,
      [userId, holder]
    );
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM users WHERE user_id = $1', [userId]);
  }

  // At-rest key rotation (#57b)

  async listUserCiphertextsNotIn(
    currentPrefix: string,
    afterUserId: string | undefined,
    limit: number
  ): Promise<StoredUserCiphertext[]> {
    const res = await this.db.query<{
      user_id: string;
      encrypted_refresh_token: string;
      encrypted_access_token: string | null;
      access_token_expires_at: string | number | null;
    }>(
      `SELECT user_id, encrypted_refresh_token, encrypted_access_token, access_token_expires_at FROM users
       WHERE (substr(encrypted_refresh_token, 1, $1) <> $2
              OR (encrypted_access_token IS NOT NULL AND substr(encrypted_access_token, 1, $1) <> $2))
         AND ($3::text IS NULL OR user_id > $3)
       ORDER BY user_id LIMIT $4`,
      [currentPrefix.length, currentPrefix, afterUserId ?? null, limit]
    );
    return res.rows.map((r) => ({
      userId: r.user_id,
      encryptedRefreshToken: r.encrypted_refresh_token,
      encryptedAccessToken: r.encrypted_access_token ?? undefined,
      accessTokenExpiresAt: optionalMillis(r.access_token_expires_at),
    }));
  }

  async rekeyUserRefreshToken(userId: string, oldCiphertext: string, newCiphertext: string): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const res = await client.query(
        'UPDATE users SET encrypted_refresh_token = $1 WHERE user_id = $2 AND encrypted_refresh_token = $3',
        [newCiphertext, userId, oldCiphertext]
      );
      if (res.rowCount !== 1) return false;
      // #64b: the same token, so a refusal marker moves with it (under the
      // users row lock the UPDATE holds, so a sign-in reads one or the other).
      const oldKey = rejectedYnabTokenKey(userId, oldCiphertext);
      const marker = await client.query<{ expires_at: string | number | null }>(
        `${REJECTED_YNAB_TOKEN_SQL} FOR UPDATE`,
        [oldKey, userId]
      );
      const found = marker.rows[0];
      if (found) {
        const now = Date.now();
        await client.query('DELETE FROM oauth_rows WHERE key = $1', [oldKey]);
        await client.query(
          UPSERT_OAUTH_ROW,
          oauthRowParams(rejectedYnabTokenRow(userId, newCiphertext, optionalMillis(found.expires_at) ?? now), now)
        );
      }
      return true;
    });
  }

  async rekeyUserAccessToken(userId: string, oldCiphertext: string, newCiphertext: string | undefined): Promise<boolean> {
    const res =
      newCiphertext === undefined
        ? await this.db.query(
            `UPDATE users SET encrypted_access_token = NULL, access_token_expires_at = NULL
             WHERE user_id = $1 AND encrypted_access_token = $2`,
            [userId, oldCiphertext]
          )
        : await this.db.query(
            'UPDATE users SET encrypted_access_token = $1 WHERE user_id = $2 AND encrypted_access_token = $3',
            [newCiphertext, userId, oldCiphertext]
          );
    return res.rowCount === 1;
  }

  async listStagedSignInCiphertexts(now: number): Promise<string[]> {
    const res = await this.db.query<{ account_id: string | null; payload: string }>(
      `SELECT account_id, payload FROM oauth_rows
       WHERE model = 'SignIn' AND (expires_at IS NULL OR expires_at >= $1)`,
      [now]
    );
    return res.rows.flatMap((r) => signInCiphertext(r.account_id, r.payload) ?? []);
  }

  async getRetiredKeyFloor(): Promise<number> {
    const res = await this.db.query<{ value: string }>('SELECT value FROM schema_meta WHERE key = $1', [
      RETIRED_FLOOR_KEY,
    ]);
    return parseRetiredFloor(res.rows[0]?.value);
  }

  async getKeyFloors(): Promise<KeyFloors> {
    const res = await this.db.query<{ key: string; value: string }>(
      'SELECT key, value FROM schema_meta WHERE key = $1 OR key = $2',
      [RETIRED_FLOOR_KEY, RETIRING_FLOOR_KEY]
    );
    return floorsFromRows(res.rows);
  }

  async ensureKeyFloorRows(): Promise<void> {
    await this.db.query(
      "INSERT INTO schema_meta (key, value) VALUES ($1, '0'), ($2, '0') ON CONFLICT (key) DO NOTHING",
      [RETIRED_FLOOR_KEY, RETIRING_FLOOR_KEY]
    );
  }

  async announceKeyRetirement(floor: number): Promise<number> {
    await this.db.query(RAISE_FLOOR_SQL, [RETIRING_FLOOR_KEY, String(floor)]);
    return (await this.getKeyFloors()).retiring;
  }

  async raiseRetiredKeyFloor(floor: number, deadCiphertexts: readonly string[] = []): Promise<number> {
    await this.inTransaction(async (client) => {
      // Take the floor row FOR UPDATE first: a users write holding it FOR
      // SHARE (guardCiphertext) commits before the compare-and-set below runs,
      // so the compare-and-set sees its row; one that comes later waits, then
      // reads the new floor and refuses.
      await client.query("INSERT INTO schema_meta (key, value) VALUES ($1, '0') ON CONFLICT (key) DO NOTHING", [
        RETIRED_FLOOR_KEY,
      ]);
      await client.query('SELECT 1 FROM schema_meta WHERE key = $1 FOR UPDATE', [RETIRED_FLOOR_KEY]);
      await client.query(CONDITIONAL_RAISE_FLOOR_SQL.postgres, [
        RETIRED_FLOOR_KEY,
        String(floor),
        floor,
        [...deadCiphertexts],
      ]);
    });
    return this.getRetiredKeyFloor();
  }

  async recordEncryptionKeyCheck(keyId: number, check: string): Promise<KeyCheckOutcome> {
    const key = keyCheckMetaKey(keyId);
    const inserted = await this.db.query(
      'INSERT INTO schema_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, check]
    );
    if (inserted.rowCount === 1) return 'recorded';
    const res = await this.db.query<{ value: string }>('SELECT value FROM schema_meta WHERE key = $1', [key]);
    return compareKeyCheck(res.rows[0]?.value ?? '', check);
  }

  async deleteUserData(userId: string, onlyIf?: InactiveUserCondition): Promise<boolean> {
    return this.refusable(async (client) => {
      await client.query(LOCK_ACCOUNT, [userId]);
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
      // The user's oidc-provider grants share the family lock space (LOCK_FAMILY by grant id).
      const grants = (await client.query<{ grant_id: string }>(USER_GRANTS_SQL, [userId])).rows
        .map((r) => r.grant_id)
        .sort();
      for (const id of [...new Set([...families, ...grants])].sort()) await client.query(LOCK_FAMILY, [id]);
      if (onlyIf) {
        // #54e: re-check the inactive-user condition under the locks. The user
        // row FOR UPDATE (after the family locks, the order token minting
        // takes HOLD_USER in) waits for a sign-in, refresh write-back or token
        // mint in flight; every later statement then sees what it committed,
        // and a later one waits for this transaction and finds the row gone.
        const user = await client.query<{ last_seen_at: string | number | null }>(
          'SELECT last_seen_at FROM users WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        const lastSeen = optionalMillis(user.rows[0]?.last_seen_at);
        if (lastSeen === undefined || lastSeen >= onlyIf.seenBefore) throw new Refusal(false);
        const live = await client.query(USER_LIVE_GRANT_SQL, userLiveGrantParams(userId, onlyIf.now, this.retention));
        if ((live.rowCount ?? 0) > 0) throw new Refusal(false);
      }
      // Every table of the catalog, in its order (src/storage/user-data.ts). The
      // user row first: a transaction minting tokens holds it FOR KEY SHARE
      // (HOLD_USER), so it either commits before this DELETE (and its tokens,
      // committed by then, are deleted below) or finds the row gone. Codes
      // before code tombstones, so a code spent concurrently has its tombstone
      // committed before that DELETE reads. Token rows before tombstones, as
      // revokeConsumedAuthCode writes them. Tombstones written by 0.4.x carry
      // no user and are matched by family; a row under one of the user's
      // grants is matched by grant.
      for (const entry of USER_DATA_TABLES) {
        await client.query(
          userDataDeleteSql(entry, 'postgres'),
          userDataDeleteParams(entry, 'postgres', userId, { families, grants })
        );
      }
      return true;
    });
  }

  async listInactiveUsers(seenBefore: number, afterUserId: string | undefined, limit: number): Promise<string[]> {
    const res = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM users
       WHERE last_seen_at IS NOT NULL AND last_seen_at < $1 AND ($2::text IS NULL OR user_id > $2)
       ORDER BY user_id LIMIT $3`,
      [seenBefore, afterUserId ?? null, limit]
    );
    return res.rows.map((r) => r.user_id);
  }

  // The audit log (#60a). One statement each; a guarded insert holds the user row FOR KEY SHARE (see AuditGuard).

  async appendAuditEntry(entry: AuditRecord, guard?: AuditGuard): Promise<boolean> {
    const { sql, params } = auditInsert('postgres', entry, guard);
    return ((await this.db.query(sql, params)).rowCount ?? 0) === 1;
  }

  async listAuditEntries(userId: string, query: AuditQuery, limit: number): Promise<AuditRecord[]> {
    const { sql, params } = auditListSql('postgres', userId, query, limit);
    return (await this.db.query<AuditRow & QueryResultRow>(sql, params)).rows.map(auditRecordFromRow);
  }

  async countAuditEntries(userId: string, query: AuditQuery): Promise<Record<string, number>> {
    const { sql, params } = auditCountSql('postgres', userId, query);
    const counts: Record<string, number> = {};
    for (const r of (await this.db.query<{ outcome: string; n: string }>(sql, params)).rows) {
      counts[r.outcome] = Number(r.n);
    }
    return counts;
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
    const now = Date.now();
    const grants = await this.db.query<GrantConnectionRow & QueryResultRow>(
      `SELECT g.grant_id, g.client_id, g.payload AS grant_payload, g.created_at AS grant_created_at,
              c.payload AS client_payload, t.created_at AS token_created_at, t.expires_at AS token_expires_at
       FROM oauth_rows g
       JOIN oauth_rows t ON t.grant_id = g.grant_id AND t.model IN ('AccessToken','RefreshToken')
         AND t.consumed_at IS NULL AND t.expires_at >= $2
       JOIN users u ON u.user_id = t.account_id AND t.created_at >= COALESCE(u.created_at, 0)
       LEFT JOIN oauth_rows c ON c.model = 'Client' AND c.client_id = g.client_id
       WHERE g.model = 'Grant' AND g.account_id = $1`,
      [userId, now]
    );
    return sortConnections([
      ...connectionsFromRows(res.rows, this.retention, now),
      ...connectionsFromGrantRows(grants.rows),
    ]);
  }

  async revokeUserFamily(userId: string, familyId: string): Promise<boolean> {
    // user_id is in every WHERE: another user's family is a no-op.
    return this.inTransaction(async (client) => {
      // The account lock first, as every oidc-provider write takes it.
      await client.query(LOCK_ACCOUNT, [userId]);
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
      const oldRevoked = (access.rowCount ?? 0) + (refresh.rowCount ?? 0) + (codes.rowCount ?? 0) > 0;
      // The library's grants: only the user's own grant is revoked (its lock is held above).
      const owned = await client.query(
        "SELECT 1 FROM oauth_rows WHERE key = $1 AND model = 'Grant' AND account_id = $2",
        [plainRowKey('Grant', familyId), userId]
      );
      if ((owned.rowCount ?? 0) === 0) return oldRevoked;
      const deleted = await client.query('DELETE FROM oauth_rows WHERE grant_id = $1', [familyId]);
      return oldRevoked || (deleted.rowCount ?? 0) > 0;
    });
  }

  async deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number> {
    return this.inTransaction(async (client) => {
      await client.query(LOCK_ACCOUNT, [userId]);
      const found = await client.query<{ family_id: string }>(
        `SELECT family_id FROM access_tokens WHERE user_id = $1 AND client_id = $2 AND family_id IS NOT NULL
         UNION SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND client_id = $2 AND family_id IS NOT NULL
         UNION SELECT family_id FROM consumed_auth_codes WHERE user_id = $1 AND client_id = $2 AND NOT revoked`,
        [userId, clientId]
      );
      const families = found.rows.map((r) => r.family_id).sort();
      const grantRows = await client.query<{ grant_id: string }>(
        "SELECT grant_id FROM oauth_rows WHERE model = 'Grant' AND account_id = $1 AND client_id = $2 AND grant_id IS NOT NULL",
        [userId, clientId]
      );
      const grants = grantRows.rows.map((r) => r.grant_id).sort();
      for (const id of [...new Set([...families, ...grants])].sort()) await client.query(LOCK_FAMILY, [id]);
      if (grants.length > 0) {
        await client.query('DELETE FROM oauth_rows WHERE grant_id = ANY($1::text[])', [grants]);
      }
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
      return families.length + (unfamilied.rowCount ?? 0) + grants.length;
    });
  }

  // oidc-provider rows (OAuthRowStore, ADR-0002 D4). The lock order of every
  // transaction here and in deleteUserData, revokeUserFamily and
  // deleteTokenFamiliesForClient: LOCK_ACCOUNT, then LOCK_FAMILY per grant
  // (sorted), then HOLD_USER, then rows. A grant-only revocation takes only
  // LOCK_FAMILY(grant).

  /** Run `fn` in a transaction; a thrown {@link Refusal} rolls it back and returns its value. */
  private async refusable<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.inTransaction(fn);
    } catch (err) {
      if (err instanceof Refusal) return err.value as T;
      throw err;
    }
  }

  async upsertOAuthRow(row: OAuthRowWrite): Promise<void> {
    if (GRANT_TOKEN_MODELS.has(row.model) || row.model === 'SignIn') {
      throw new Error(`upsertOAuthRow cannot write a ${row.model} row`);
    }
    await this.db.query(UPSERT_OAUTH_ROW, oauthRowParams(row, Date.now()));
  }

  async compareAndSetOAuthRow(expected: string | undefined, row: OAuthRowWrite): Promise<boolean> {
    if (GRANT_TOKEN_MODELS.has(row.model) || row.model === 'SignIn') {
      throw new Error(`compareAndSetOAuthRow cannot write a ${row.model} row`);
    }
    const params = oauthRowParams(row, Date.now());
    const res =
      expected === undefined
        ? await this.db.query(INSERT_OAUTH_ROW_IF_ABSENT, params)
        : await this.db.query(REPLACE_OAUTH_ROW_IF, [...params.slice(0, 8), expected]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Whether the grant row a grant-bound row names exists for its account and client (held FOR KEY SHARE). */
  private async liveGrantFor(client: PoolClient, row: OAuthRowWrite): Promise<boolean> {
    if (row.grantId === undefined || row.accountId === undefined || row.clientId === undefined) return false;
    const res = await client.query(LIVE_GRANT_SQL, [plainRowKey('Grant', row.grantId), row.accountId, row.clientId]);
    return (res.rowCount ?? 0) > 0;
  }

  async saveGrantToken(row: OAuthRowWrite): Promise<boolean> {
    if (row.model !== 'AccessToken' && row.model !== 'RefreshToken') {
      throw new Error(`saveGrantToken cannot write a ${row.model} row`);
    }
    if (row.accountId === undefined || row.grantId === undefined) return false;
    const accountId = row.accountId;
    const grantId = row.grantId;
    return this.refusable(async (client) => {
      await client.query(LOCK_ACCOUNT, [accountId]);
      await client.query(LOCK_FAMILY, [grantId]);
      const user = await client.query(HOLD_USER, [accountId]);
      if (user.rowCount === 0) throw new Refusal(false);
      if (!(await this.liveGrantFor(client, row))) throw new Refusal(false);
      await client.query(UPSERT_OAUTH_ROW, oauthRowParams(row, Date.now()));
      return true;
    });
  }

  async saveAuthorizationCode(row: OAuthRowWrite): Promise<CodeSaveOutcome> {
    if (row.model !== 'AuthorizationCode') throw new Error(`saveAuthorizationCode cannot write a ${row.model} row`);
    if (row.accountId === undefined || row.grantId === undefined) return 'grant-gone';
    const accountId = row.accountId;
    const grantId = row.grantId;
    return this.refusable<CodeSaveOutcome>(async (client) => {
      await client.query(LOCK_ACCOUNT, [accountId]);
      await client.query(LOCK_FAMILY, [grantId]);
      // After the locks: a wait for them must not leave the staged sign-in's
      // expiry check on a clock from before it.
      const now = Date.now();
      // An UPDATE, not a bare lock: a sweep DELETE already waiting on this row
      // re-checks its predicate against the new version. A refusal below rolls
      // the stamp back.
      const stamped =
        row.clientId === undefined
          ? undefined
          : await client.query(
              "UPDATE oauth_rows SET authorized_at = $2 WHERE key = $1 AND model = 'Client' RETURNING key",
              [plainRowKey('Client', row.clientId), now]
            );
      if (!stamped || stamped.rowCount === 0) throw new Refusal<CodeSaveOutcome>('client-gone');
      if (!(await this.liveGrantFor(client, row))) throw new Refusal<CodeSaveOutcome>('grant-gone');
      const signInKey = plainRowKey('SignIn', grantId);
      const signIn = await client.query<{ payload: string }>(
        `SELECT payload FROM oauth_rows
         WHERE key = $1 AND model = 'SignIn' AND account_id = $2 AND expires_at >= $3 FOR UPDATE`,
        [signInKey, accountId, now]
      );
      const staged = signIn.rows[0];
      const user = staged && userFromSignIn(accountId, staged.payload);
      if (!user) throw new Refusal<CodeSaveOutcome>('no-sign-in');
      await applySignIn(client, user, grantId, now);
      await client.query('DELETE FROM oauth_rows WHERE key = $1', [signInKey]);
      await client.query(UPSERT_OAUTH_ROW, oauthRowParams(row, now));
      return 'saved';
    });
  }

  async stageSignIn(signIn: StagedSignIn): Promise<boolean> {
    return this.refusable(async (client) => {
      await client.query(LOCK_ACCOUNT, [signIn.user.userId]);
      // The grant's lock too, so a grant-only revocation waits for the staging and deletes its row.
      await client.query(LOCK_FAMILY, [signIn.grantId]);
      const grant = await client.query<{ client_id: string | null }>(
        "SELECT client_id FROM oauth_rows WHERE key = $1 AND model = 'Grant' AND account_id = $2 FOR KEY SHARE",
        [plainRowKey('Grant', signIn.grantId), signIn.user.userId]
      );
      if (grant.rowCount === 0) throw new Refusal(false);
      const key = plainRowKey('SignIn', signIn.grantId);
      await client.query('DELETE FROM oauth_rows WHERE key = $1', [key]);
      await client.query(
        UPSERT_OAUTH_ROW,
        oauthRowParams(
          {
            key,
            model: 'SignIn',
            payload: signInPayload(signIn.user),
            grantId: signIn.grantId,
            accountId: signIn.user.userId,
            clientId: grant.rows[0]?.client_id ?? undefined,
            uid: undefined,
            expiresAt: signIn.expiresAt,
          },
          Date.now()
        )
      );
      return true;
    });
  }

  async findOAuthRow(key: string): Promise<OAuthRowRecord | undefined> {
    const res = await this.db.query<OAuthRowRow & QueryResultRow>(
      `SELECT r.* FROM oauth_rows r WHERE r.key = $1
         AND (r.model NOT IN ('AccessToken','RefreshToken','AuthorizationCode')
           OR (EXISTS (SELECT 1 FROM oauth_rows g WHERE g.grant_id = r.grant_id AND g.model = 'Grant')
               AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = r.account_id
                           AND r.created_at >= COALESCE(u.created_at, 0))))`,
      [key]
    );
    const row = res.rows[0];
    return row && oauthRowFromRow(row);
  }

  async findOAuthRowByUid(uid: string): Promise<OAuthRowRecord | undefined> {
    const res = await this.db.query<OAuthRowRow & QueryResultRow>(
      "SELECT * FROM oauth_rows WHERE uid = $1 AND model = 'Session' ORDER BY created_at DESC LIMIT 1",
      [uid]
    );
    const row = res.rows[0];
    return row && oauthRowFromRow(row);
  }

  async consumeOAuthRow(key: string): Promise<ConsumeOutcome> {
    return this.inTransaction<ConsumeOutcome>(async (client) => {
      // Compare-and-set: under READ COMMITTED a concurrent second UPDATE waits
      // for this row's lock, rechecks consumed_at IS NULL against the committed
      // version and matches nothing.
      const won = await client.query(
        `UPDATE oauth_rows SET consumed_at = $2
         WHERE key = $1 AND consumed_at IS NULL AND model IN ('RefreshToken','AuthorizationCode') RETURNING key`,
        [key, Date.now()]
      );
      if (won.rowCount === 1) return 'consumed';
      const found = await client.query<{ model: OAuthModel; grant_id: string | null }>(
        'SELECT model, grant_id FROM oauth_rows WHERE key = $1',
        [key]
      );
      const row = found.rows[0];
      if (!row) return 'missing';
      if (!CONSUMABLE_MODELS.has(row.model)) throw new Error(`consumeOAuthRow cannot consume a ${row.model} row`);
      // Lost the compare-and-set: someone consumed it first. That is reuse.
      if (row.grant_id === null) {
        await client.query('DELETE FROM oauth_rows WHERE key = $1', [key]);
      } else {
        await client.query(LOCK_FAMILY, [row.grant_id]);
        await client.query('DELETE FROM oauth_rows WHERE grant_id = $1', [row.grant_id]);
      }
      return 'replayed';
    });
  }

  async destroyOAuthRow(key: string): Promise<boolean> {
    // One statement: the row and, when it is a client, its registration access
    // tokens (nothing else reads them).
    const res = await this.db.query(
      `WITH gone AS (DELETE FROM oauth_rows WHERE key = $1 RETURNING model, client_id),
            tokens AS (DELETE FROM oauth_rows t USING gone
              WHERE gone.model = 'Client' AND t.model = 'RegistrationAccessToken' AND t.client_id = gone.client_id)
       SELECT count(*)::int AS n FROM gone`,
      [key]
    );
    return Number((res.rows[0] as { n?: unknown } | undefined)?.n ?? 0) > 0;
  }

  async revokeOAuthGrant(grantId: string): Promise<number> {
    return this.inTransaction(async (client) => {
      await client.query(LOCK_FAMILY, [grantId]);
      const res = await client.query('DELETE FROM oauth_rows WHERE grant_id = $1', [grantId]);
      return res.rowCount ?? 0;
    });
  }

  async sweepExpired(options: SweepOptions = {}): Promise<SweepResult> {
    // A session-level try-lock on a dedicated connection: a second sweeper
    // (another replica) skips instead of queueing. Each batch then runs as its
    // own statement, so no transaction holds a large lock set.
    const client = await this.connect();
    let broken: Error | undefined;
    try {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, hashtext(current_schema())) AS locked',
        [SWEEP_LOCK_KEY]
      );
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
        await client.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [SWEEP_LOCK_KEY]).catch((err: unknown) => {
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

  /** A pooled connection that is discarded, not returned, once a query on it timed out client side. */
  private async connect(): Promise<PoolClient> {
    return guardClient(await this.db.connect());
  }

  /** Run `fn` in a transaction on one pooled connection; rolled back if it throws. */
  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
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
    // One statement, so the client's last_seen_at is stamped as the pending row
    // goes: a sweep never sees the client with neither (see sweepExpired).
    const res = await this.db.query<PendingRow>(
      `WITH taken AS (DELETE FROM pending_auth WHERE state = $1 RETURNING *),
       seen AS (UPDATE oauth_clients SET last_seen_at = $2 WHERE client_id IN (SELECT client_id FROM taken))
       SELECT * FROM taken`,
      [state, Date.now()]
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
    await this.db.query(INSERT_AUTH_CODE_SQL, authCodeParams(rec));
  }

  async completeAuthorization(input: { user: UserRecord; code: AuthCodeRecord }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      // An UPDATE, not a bare lock: a sweep DELETE already waiting on this row
      // re-checks its predicate (last_seen_at) against the new version and
      // skips it, which a FOR KEY SHARE lock would not make it do. A sweep that
      // locks the row first (it skips locked rows) makes this UPDATE match
      // nothing once it commits, and nothing is written.
      const seen = await client.query(
        'UPDATE oauth_clients SET last_seen_at = $2 WHERE client_id = $1 RETURNING client_id',
        [input.code.clientId, Date.now()]
      );
      if (seen.rowCount === 0) return false;
      await applyStagedUser(client, input.user, Date.now());
      await client.query(INSERT_AUTH_CODE_SQL, authCodeParams(input.code));
      return true;
    });
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
    const client = await this.connect();
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
    const client = await this.connect();
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
    const client = await this.connect();
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
    const client = await this.connect();
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
