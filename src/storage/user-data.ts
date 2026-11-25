/**
 * Where a user's data lives: the catalog `deleteUserData` erases by on the SQL
 * drivers (STOR-1, ADR-0002 D4 and D12). A table that gains a user column is
 * covered by adding one entry here (as #60a's `audit_log`, schema 7, was);
 * tests/unit/storage/user-data.test.ts fails while any table with a
 * `user_id` or `account_id` column is missing.
 *
 * The order is the deletion order, and the Postgres protocol depends on it:
 * the user row first (a transaction minting tokens holds it FOR KEY SHARE, so
 * it either commits before that DELETE and its tokens go below, or finds the
 * row gone), codes before code tombstones, tokens before tombstones (the order
 * the replay revocation writes them in), then the oidc-provider rows, and the
 * audit rows (D-7b: erasing an account erases its audit log; an audit
 * insert holds the user row, so it lands before this erase or not at all),
 * then the user's shared rate-limit bucket and write-cap row (#67c; a request
 * still in flight may write them again, which the sweep removes once they
 * limit nothing).
 * Memory storage mirrors the same entries in its own maps.
 */

import type { Dialect } from './migrations.js';
import type { RetentionPolicy } from '../auth/retention-defaults.js';

/** The id sets `deleteUserData` collects before erasing: the user's 0.4.x token families and oidc-provider grants. */
export type UserIdSet = 'families' | 'grants';

export interface UserDataTable {
  table: string;
  /** The column holding the user id. */
  column: string;
  /**
   * The user's rows that don't carry the id: matched by `column` against one
   * of the collected id sets (0.4.x refresh tombstones carry no user; a row
   * under one of the user's grants need not carry an account).
   */
  orIn?: { column: string; ids: UserIdSet };
}

/** Every table holding a user's data, in deletion order. */
export const USER_DATA_TABLES: readonly UserDataTable[] = [
  { table: 'users', column: 'user_id' },
  // 0.4.x token tables (D12: never read after the cut-over, still erased).
  { table: 'auth_codes', column: 'user_id' },
  { table: 'access_tokens', column: 'user_id' },
  { table: 'refresh_tokens', column: 'user_id' },
  { table: 'consumed_auth_codes', column: 'user_id' },
  { table: 'consumed_refresh_tokens', column: 'user_id', orIn: { column: 'family_id', ids: 'families' } },
  // oidc-provider rows (M4).
  { table: 'oauth_rows', column: 'account_id', orIn: { column: 'grant_id', ids: 'grants' } },
  // The audit log (M6, #60a; D-7b).
  { table: 'audit_log', column: 'user_id' },
  // The shared YNAB request budget (M7, #67c): one row per user, no lock order to keep.
  { table: 'rate_limit_buckets', column: 'user_id' },
  // The shared write cap (M7, #61c across replicas).
  { table: 'rate_limit_writes', column: 'user_id' },
];

/** The user's oidc-provider grants (`$1` = the user id). */
export const USER_GRANTS_SQL = `SELECT grant_id FROM oauth_rows WHERE model = 'Grant' AND account_id = $1`;

/**
 * The DELETE for one entry. Parameters: the user id, then (for an entry with
 * `orIn`) the id set, as a text array on Postgres and as JSON text on SQLite.
 */
export function userDataDeleteSql(entry: UserDataTable, dialect: Dialect): string {
  const base = `DELETE FROM ${entry.table} WHERE ${entry.column} = $1`;
  if (!entry.orIn) return base;
  const set = dialect === 'postgres' ? `= ANY($2::text[])` : `IN (SELECT value FROM json_each($2))`;
  return `${base} OR ${entry.orIn.column} ${set}`;
}

/** The parameters for {@link userDataDeleteSql}. */
export function userDataDeleteParams(
  entry: UserDataTable,
  dialect: Dialect,
  userId: string,
  ids: Readonly<Record<UserIdSet, readonly string[]>>
): unknown[] {
  if (!entry.orIn) return [userId];
  const set = ids[entry.orIn.ids];
  return [userId, dialect === 'postgres' ? [...set] : JSON.stringify(set)];
}

/**
 * #54e's live-grant rule: a user with any of these is never erased as
 * inactive. An oidc-provider token, code or staged sign-in under the user's
 * account that is unconsumed and unexpired (what `listConnections` reports,
 * plus a sign-in in flight), or a 0.4.x access token, code or refresh token
 * not past its limits. The generation rule (`issuedUnderUser`) is not
 * applied: a dead row of an older generation counts as live, which only
 * delays the erase until the expiry sweep removes it.
 *
 * Parameters (in order, once each, valid on both SQL dialects): see
 * {@link userLiveGrantParams}.
 */
export const USER_LIVE_GRANT_SQL = `SELECT 1 AS live FROM oauth_rows
    WHERE account_id = $1 AND model IN ('AccessToken', 'RefreshToken', 'AuthorizationCode', 'SignIn')
      AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at >= $2)
  UNION ALL SELECT 1 FROM access_tokens WHERE user_id = $3 AND expires_at >= $4
  UNION ALL SELECT 1 FROM auth_codes WHERE user_id = $5 AND expires_at >= $6
  UNION ALL SELECT 1 FROM refresh_tokens WHERE user_id = $7
      AND (issued_at IS NULL OR issued_at >= $8) AND (family_created_at IS NULL OR family_created_at >= $9)
  LIMIT 1`;

/** The parameters of {@link USER_LIVE_GRANT_SQL}: the user, the clock, and the refresh-token limits as cutoffs. */
export function userLiveGrantParams(
  userId: string,
  now: number,
  policy: Pick<RetentionPolicy, 'refreshTokenIdleMs' | 'refreshTokenTtlMs'>
): unknown[] {
  return [
    userId,
    now,
    userId,
    now,
    userId,
    now,
    userId,
    now - policy.refreshTokenIdleMs,
    now - policy.refreshTokenTtlMs,
  ];
}
