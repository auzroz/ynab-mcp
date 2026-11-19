/**
 * Where a user's data lives: the catalog `deleteUserData` erases by on the SQL
 * drivers (STOR-1, ADR-0002 D4 and D12). A table that gains a user column is
 * covered by adding one entry here (#60b's `audit_log` in M5, for example);
 * tests/unit/storage/user-data.test.ts fails while any table with a
 * `user_id` or `account_id` column is missing.
 *
 * The order is the deletion order, and the Postgres protocol depends on it:
 * the user row first (a transaction minting tokens holds it FOR KEY SHARE, so
 * it either commits before that DELETE and its tokens go below, or finds the
 * row gone), codes before code tombstones, tokens before tombstones (the order
 * the replay revocation writes them in), and the oidc-provider rows last.
 * Memory storage mirrors the same entries in its own maps.
 */

import type { Dialect } from './migrations.js';

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
