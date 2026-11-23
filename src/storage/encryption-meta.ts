/**
 * The at-rest key rotation's shared storage rules (#57b), for every driver:
 * the `schema_meta` keys of the key floors and the per-key check values, the
 * conditional raise of the retirement floor, and reading a staged sign-in's
 * ciphertext. Runtime state, not a migration step: the tables already exist
 * (M0, M4).
 */

import { constantTimeEqual } from '../auth/token-hash.js';
import { ciphertextVersion } from '../crypto.js';
import { userFromSignIn } from './oauth-rows.js';
import type { KeyCheckOutcome, KeyFloors } from './types.js';

/** `schema_meta` key of the retirement floor: `v1` and key ids below it are refused. */
export const RETIRED_FLOOR_KEY = 'encryption_retired_below';

/**
 * `schema_meta` key of the announced floor: key ids below it are being
 * retired, so no replica whose current key id is below it may write.
 */
export const RETIRING_FLOOR_KEY = 'encryption_retiring_below';

/** `schema_meta` key of key `id`'s check value. */
export function keyCheckMetaKey(id: number): string {
  return `encryption_key_check.${id}`;
}

/**
 * Upsert that raises a floor only when the new value is higher: one
 * statement, so two replicas raising it at once keep the higher. Valid on
 * SQLite (3.24+) and Postgres; `$1`/`$2` are the key and the floor as text.
 */
export const RAISE_FLOOR_SQL = `INSERT INTO schema_meta (key, value) VALUES ($1, $2)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
  WHERE CAST(schema_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`;

/**
 * The retirement floor's conditional raise, one statement per dialect: as
 * {@link RAISE_FLOOR_SQL}, but nothing is written while a `users` row holds a
 * `v1` ciphertext or one under a key id below the floor, other than the
 * listed dead ones. Parameters: the key, the floor as text, the floor as an
 * integer, the dead ciphertexts (a text array on Postgres, a JSON array on
 * SQLite).
 */
export const CONDITIONAL_RAISE_FLOOR_SQL = {
  postgres: `INSERT INTO schema_meta (key, value)
    SELECT $1, $2 WHERE NOT EXISTS (
      SELECT 1 FROM users
      WHERE (encrypted_refresh_token LIKE 'v1.%'
         OR CASE WHEN encrypted_refresh_token ~ '^v2\\.[1-9][0-9]{0,5}\\.'
                 THEN CAST(split_part(encrypted_refresh_token, '.', 2) AS INTEGER) < $3
                 ELSE FALSE END)
        AND NOT (encrypted_refresh_token = ANY($4::text[])))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE CAST(schema_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
  sqlite: `INSERT INTO schema_meta (key, value)
    SELECT ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM users
      WHERE (encrypted_refresh_token LIKE 'v1.%'
         OR (encrypted_refresh_token LIKE 'v2.%'
             AND CAST(substr(encrypted_refresh_token, 4, instr(substr(encrypted_refresh_token, 4), '.') - 1) AS INTEGER)
                 BETWEEN 1 AND ? - 1))
        AND encrypted_refresh_token NOT IN (SELECT value FROM json_each(?)))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE CAST(schema_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
} as const;

/**
 * Whether a stored ciphertext is `v1` or under a key id below `floor` (the
 * rule {@link CONDITIONAL_RAISE_FLOOR_SQL} applies, for the memory driver).
 */
export function isBelowFloor(ciphertext: string, floor: number): boolean {
  if (ciphertext.startsWith('v1.')) return true;
  const version = ciphertextVersion(ciphertext);
  return version?.format === 'v2' && version.kid < floor;
}

/** Parse a stored floor; undefined (nothing stored) is 0. Throws, value-free, on anything else. */
export function parseRetiredFloor(value: string | undefined, key: string = RETIRED_FLOOR_KEY): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9]\d{0,5})$/.test(value)) {
    throw new Error(
      `The database records an unreadable ${key} in schema_meta; refusing to start. Restore a backup or fix the value.`
    );
  }
  return Number(value);
}

/**
 * A ciphertext write refused because its key id is being retired: below the
 * retired floor at the storage write ({@link assertFloorAllows}), or below
 * the retired or the announced floor at the write-path check before a YNAB
 * call (src/auth/rekey-job.ts). Never carries a value; callers map it to
 * their fixed client message.
 */
export class KeyRetiredError extends Error {
  constructor(keyId: number, floor: number) {
    super(
      `Refusing to write with ENCRYPTION_KEY_ID ${keyId}: key ids below ${floor} are being retired. ` +
        'Set ENCRYPTION_KEY and ENCRYPTION_KEY_ID to the newest key on this replica (see "Rotating ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md).'
    );
    this.name = 'KeyRetiredError';
  }
}

/** The key id a ciphertext is written under; 0 for `v1` or anything not `v2` (refused under any floor). */
export function writeKeyId(ciphertext: string): number {
  const version = ciphertextVersion(ciphertext);
  return version?.format === 'v2' ? version.kid : 0;
}

/**
 * The persistence-time guard (#57b): throw {@link KeyRetiredError} when
 * `ciphertext` is under a key id below the RETIRED floor, so a write that
 * passed the write-path check and then waited past a retirement is refused
 * instead of storing a token no replica reads. Drivers call it with the floor
 * read in the same transaction as the write (Postgres: locked FOR SHARE,
 * which the retirement's FOR UPDATE waits for; SQLite: under the write lock).
 *
 * The announced floor is deliberately not checked here. A write that lands
 * after the announcement but before the retirement (a refresh already in
 * flight when the announcement came, whose YNAB token has just rotated) is
 * still readable: the old key is still configured everywhere. It holds the
 * retirement's compare-and-set back, and the next rekey pass rewrites it.
 * Refusing it would only throw the rotated token away. New operations are
 * stopped below the announced floor before they reach YNAB, by the
 * write-path check.
 */
export function assertFloorAllows(floors: KeyFloors, ciphertext: string): void {
  const kid = writeKeyId(ciphertext);
  if (kid < floors.retired) throw new KeyRetiredError(kid, floors.retired);
}

/** Both floors from `schema_meta` rows (`key`, `value`). */
export function floorsFromRows(rows: ReadonlyArray<{ key: string; value: string }>): KeyFloors {
  const value = (key: string): string | undefined => rows.find((r) => r.key === key)?.value;
  return {
    retired: parseRetiredFloor(value(RETIRED_FLOOR_KEY)),
    retiring: parseRetiredFloor(value(RETIRING_FLOOR_KEY), RETIRING_FLOOR_KEY),
  };
}

/** Compare a recorded key check with this key's (constant time). */
export function compareKeyCheck(stored: string, check: string): KeyCheckOutcome {
  return constantTimeEqual(stored, check) ? 'matches' : 'differs';
}

/** A staged sign-in's refresh-token ciphertext; undefined when its payload is unreadable. */
export function signInCiphertext(accountId: string | null | undefined, payload: string): string | undefined {
  return userFromSignIn(accountId ?? '', payload)?.encryptedRefreshToken;
}
