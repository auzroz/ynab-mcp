/**
 * Additive schema migrations shared by the SQLite and Postgres drivers.
 *
 * The base tables are the 0.3.x schema (created with CREATE TABLE IF NOT EXISTS).
 * Each entry here adds one nullable column; drivers apply every entry on startup
 * and skip columns that already exist, so init() is idempotent against both a
 * fresh database and one created by an older release. Never drop, rename or
 * retype columns here: a rollback to the previous release must still be able to
 * read the database.
 */

export interface AddedColumn {
  table: 'pending_auth' | 'auth_codes' | 'access_tokens' | 'refresh_tokens';
  column: 'resource';
  /** SQL type; the column is always nullable. */
  type: 'TEXT';
}

/** 0.4.0: RFC 8707 resource binding on grants and tokens. */
export const ADDED_COLUMNS: readonly AddedColumn[] = [
  { table: 'pending_auth', column: 'resource', type: 'TEXT' },
  { table: 'auth_codes', column: 'resource', type: 'TEXT' },
  { table: 'access_tokens', column: 'resource', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'resource', type: 'TEXT' },
];
