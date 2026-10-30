/**
 * Additive schema migrations shared by the SQLite and Postgres drivers.
 *
 * The base tables are the 0.3.x schema (created with CREATE TABLE IF NOT EXISTS,
 * as are tables added since, which older releases simply ignore). Each entry in
 * ADDED_COLUMNS adds one nullable column; drivers apply every entry on startup
 * and skip columns that already exist, then create ADDED_INDEXES (IF NOT
 * EXISTS), so init() is idempotent against both a fresh database and one
 * created by an older release. Never drop, rename or retype columns here: a
 * rollback to the previous release must still be able to read the database.
 */

export interface AddedColumn {
  table: 'pending_auth' | 'auth_codes' | 'access_tokens' | 'refresh_tokens';
  column: 'resource' | 'granted_scope' | 'browser_binding' | 'family_id';
  /** SQL type; the column is always nullable. */
  type: 'TEXT';
}

/** Columns added since 0.3.x, applied in order. */
export const ADDED_COLUMNS: readonly AddedColumn[] = [
  // 0.4.0: RFC 8707 resource binding on grants and tokens.
  { table: 'pending_auth', column: 'resource', type: 'TEXT' },
  { table: 'auth_codes', column: 'resource', type: 'TEXT' },
  { table: 'access_tokens', column: 'resource', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'resource', type: 'TEXT' },
  // 0.4.0: per-grant access level (read-only / read-write) on codes and tokens.
  { table: 'auth_codes', column: 'granted_scope', type: 'TEXT' },
  { table: 'access_tokens', column: 'granted_scope', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'granted_scope', type: 'TEXT' },
  // 0.4.0: hash of the consent-cookie nonce binding a pending auth to a browser.
  { table: 'pending_auth', column: 'browser_binding', type: 'TEXT' },
  // 0.4.0: refresh-token family (RFC 9700 section 4.14.2) on tokens.
  { table: 'access_tokens', column: 'family_id', type: 'TEXT' },
  { table: 'refresh_tokens', column: 'family_id', type: 'TEXT' },
];

export interface AddedIndex {
  name: string;
  table: 'access_tokens' | 'refresh_tokens' | 'consumed_refresh_tokens';
  column: 'family_id' | 'expires_at';
}

/** Indexes added since 0.3.x, created after {@link ADDED_COLUMNS}. */
export const ADDED_INDEXES: readonly AddedIndex[] = [
  // 0.4.0: family revocation, and pruning of expired refresh-token tombstones.
  { name: 'access_tokens_family_id', table: 'access_tokens', column: 'family_id' },
  { name: 'refresh_tokens_family_id', table: 'refresh_tokens', column: 'family_id' },
  { name: 'consumed_refresh_tokens_expires_at', table: 'consumed_refresh_tokens', column: 'expires_at' },
];
