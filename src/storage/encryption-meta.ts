/**
 * The at-rest key rotation's shared storage rules (#57b), for every driver:
 * the `schema_meta` keys of the retirement floor and the per-key check
 * values, and reading a staged sign-in's ciphertext. Runtime state, not a
 * migration step: the tables already exist (M0, M4).
 */

import { constantTimeEqual } from '../auth/token-hash.js';
import { userFromSignIn } from './oauth-rows.js';
import type { KeyCheckOutcome } from './types.js';

/** `schema_meta` key of the retirement floor: `v1` and key ids below it are refused. */
export const RETIRED_FLOOR_KEY = 'encryption_retired_below';

/** `schema_meta` key of key `id`'s check value. */
export function keyCheckMetaKey(id: number): string {
  return `encryption_key_check.${id}`;
}

/**
 * Upsert that raises the floor only when the new value is higher: one
 * statement, so two replicas raising it at once keep the higher. Valid on
 * SQLite (3.24+) and Postgres; `$1`/`$2` are the key and the floor as text.
 */
export const RAISE_FLOOR_SQL = `INSERT INTO schema_meta (key, value) VALUES ($1, $2)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
  WHERE CAST(schema_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`;

/** Parse a stored floor; undefined (nothing stored) is 0. Throws, value-free, on anything else. */
export function parseRetiredFloor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9]\d{0,5})$/.test(value)) {
    throw new Error(
      `The database records an unreadable ${RETIRED_FLOOR_KEY} in schema_meta; refusing to start. Restore a backup or fix the value.`
    );
  }
  return Number(value);
}

/** Compare a recorded key check with this key's (constant time). */
export function compareKeyCheck(stored: string, check: string): KeyCheckOutcome {
  return constantTimeEqual(stored, check) ? 'matches' : 'differs';
}

/** A staged sign-in's refresh-token ciphertext; undefined when its payload is unreadable. */
export function signInCiphertext(accountId: string | null | undefined, payload: string): string | undefined {
  return userFromSignIn(accountId ?? '', payload)?.encryptedRefreshToken;
}
