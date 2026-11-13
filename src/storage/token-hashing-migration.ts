/**
 * M3 (#52): hashed tokens, codes, state and client secrets at rest.
 *
 * No DDL. The data step, run under the migrate lock on every startup (see
 * Backfill in migrations.ts), in this order:
 *
 *   1. The pepper check. `schema_meta.token_pepper_fingerprint` holds
 *      HMAC(pepper, "ynab-mcp/pepper-check") from the first start. When it is
 *      missing it is written; when it differs, startup is refused with an error
 *      that carries no value, before anything is rewritten (every stored key
 *      would otherwise silently miss).
 *   2. The eager rehash. Every key still in the 0.4.x shape (43 base64url
 *      characters) in access_tokens, refresh_tokens, auth_codes,
 *      pending_auth.state, consumed_refresh_tokens and consumed_auth_codes is
 *      replaced by its `h1.` key, so a token a client already holds keeps
 *      working through the same lookup a new one uses. If the `h1.` key is
 *      already present (the row was written both ways), the plaintext row is
 *      deleted instead. A key in any other shape was never issued by any
 *      release and can't be reached by a lookup, so it is left as it is.
 *   3. DCR client secrets. `client_secret` in `oauth_clients.client_json`
 *      becomes `client_secret_hash` (`s256.<hex>`); 0.4.x reading a migrated
 *      database therefore sees confidential clients as public.
 *
 * Idempotent: once converted, a run finds no 0.4.x-shaped key and no
 * `client_secret`, and writes nothing. Rows a 0.4.x process writes after the
 * stamp are converted at the next startup; until then lookups (which use only
 * `h1.` keys) don't find them.
 *
 * Rolling back to 0.4.x after this step means every user reconnects: their
 * tokens are stored only as keys 0.4.x can't look up.
 */

import type { TokenKeyDeriver, TokenKind } from '../auth/token-hash.js';
import type { Backfill, MigrationTx } from './migrations.js';

/** The schema version M3 brings the database to (M0 is 1; STOR-1's M2 is 3). */
export const M3_SCHEMA_VERSION = 4;

/** The `schema_meta` key holding the pepper fingerprint. */
export const PEPPER_FINGERPRINT_KEY = 'token_pepper_fingerprint';

/** Every column keyed by a credential, and the kind its key is derived for. */
export const HASHED_KEY_COLUMNS: ReadonlyArray<{ table: string; column: string; kind: TokenKind }> = [
  { table: 'access_tokens', column: 'token', kind: 'access' },
  { table: 'refresh_tokens', column: 'token', kind: 'refresh' },
  { table: 'auth_codes', column: 'code', kind: 'code' },
  { table: 'pending_auth', column: 'state', kind: 'state' },
  // Tombstones are looked up with the token or code they record.
  { table: 'consumed_refresh_tokens', column: 'token', kind: 'refresh' },
  { table: 'consumed_auth_codes', column: 'code', kind: 'code' },
];

/** Refused at startup; names what to do, never a value. */
export const PEPPER_MISMATCH_MESSAGE =
  'The token pepper differs from the one this database was first started with: TOKEN_PEPPER ' +
  '(or, when TOKEN_PEPPER is unset, ENCRYPTION_KEY) has changed. Refusing to start, because every ' +
  'stored token would stop working. Restore the original value, or see "Changing TOKEN_PEPPER" in ' +
  'docs/REMOTE_HOSTING.md.';

const MISSING_HASHER_MESSAGE =
  'Storage was opened without the token hasher, which migration M3 needs; refusing to start.';

async function checkPepper(tx: MigrationTx, keys: TokenKeyDeriver): Promise<void> {
  const rows = await tx.query<{ value: string }>('SELECT value FROM schema_meta WHERE key = $1', [
    PEPPER_FINGERPRINT_KEY,
  ]);
  const stored = rows[0]?.value;
  if (stored === undefined) {
    await tx.exec('INSERT INTO schema_meta (key, value) VALUES ($1, $2)', [PEPPER_FINGERPRINT_KEY, keys.fingerprint]);
    return;
  }
  if (!keys.fingerprintMatches(stored)) throw new Error(PEPPER_MISMATCH_MESSAGE);
}

async function rehashColumn(
  tx: MigrationTx,
  keys: TokenKeyDeriver,
  { table, column, kind }: { table: string; column: string; kind: TokenKind }
): Promise<void> {
  // The SQL filter only narrows the scan; the shape check below decides.
  const rows = await tx.query<{ k: string }>(`SELECT ${column} AS k FROM ${table} WHERE ${column} NOT LIKE 'h1.%'`);
  for (const { k } of rows) {
    const key = keys.legacyStorageKey(kind, k);
    if (key === undefined) continue;
    const existing = await tx.query<{ present: number }>(`SELECT 1 AS present FROM ${table} WHERE ${column} = $1`, [key]);
    if (existing.length > 0) {
      await tx.exec(`DELETE FROM ${table} WHERE ${column} = $1`, [k]);
    } else {
      await tx.exec(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [key, k]);
    }
  }
}

async function hashClientSecrets(tx: MigrationTx, keys: TokenKeyDeriver): Promise<void> {
  // `_` is a LIKE wildcard, so this matches a superset; the parse below decides.
  const rows = await tx.query<{ client_id: string; client_json: string }>(
    `SELECT client_id, client_json FROM oauth_clients WHERE client_json LIKE '%"client_secret"%'`
  );
  for (const row of rows) {
    let client: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.client_json);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      client = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!('client_secret' in client)) continue;
    const { client_secret: secret, ...rest } = client;
    const next: Record<string, unknown> =
      typeof secret === 'string' && secret !== ''
        ? { ...rest, client_secret_hash: keys.clientSecretHash(secret) }
        : rest;
    await tx.exec('UPDATE oauth_clients SET client_json = $1 WHERE client_id = $2', [
      JSON.stringify(next),
      row.client_id,
    ]);
  }
}

export const TOKEN_HASHING_BACKFILL: Backfill = {
  version: M3_SCHEMA_VERSION,
  name: 'M3: hash tokens, codes, state and client secrets (#52)',
  async run({ tx, tokenKeys }) {
    if (!tokenKeys) throw new Error(MISSING_HASHER_MESSAGE);
    await checkPepper(tx, tokenKeys);
    for (const target of HASHED_KEY_COLUMNS) await rehashColumn(tx, tokenKeys, target);
    await hashClientSecrets(tx, tokenKeys);
  },
};
