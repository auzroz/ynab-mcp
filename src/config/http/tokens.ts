/**
 * Token hashing settings (#52): `TOKEN_PEPPER`.
 *
 * Optional. When set it must be 32 bytes (base64, or 64 hex characters, like
 * `ENCRYPTION_KEY`); when unset the pepper is derived from `ENCRYPTION_KEY`.
 * Set it before the first 0.5.0 start if you want one: the database records the
 * pepper's fingerprint then, and a later start with a different pepper (or, with
 * none, a different `ENCRYPTION_KEY`) is refused.
 *
 * Errors name the variable only, never its value.
 */

import { parseKey32 } from '../../crypto.js';
import type { HttpLoader } from './types.js';

export interface TokenSettings {
  /** `TOKEN_PEPPER`, validated; undefined when unset (the ENCRYPTION_KEY fallback applies). */
  tokenPepper: string | undefined;
}

/** Validate a `TOKEN_PEPPER` value: undefined when unset or empty; throws (value-free) when invalid. */
export function parseTokenPepper(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  // Blank but set is a mistake, not "unset": refuse it rather than fall back.
  if (raw.trim() === '') {
    throw new Error('Invalid TOKEN_PEPPER: must be 32 bytes as base64 or 64 hex characters.');
  }
  parseKey32(raw, 'TOKEN_PEPPER');
  return raw.trim();
}

export const loadTokenSettings: HttpLoader<TokenSettings> = ({ env, problems }) => ({
  tokenPepper: problems.capture('TOKEN_PEPPER', () => parseTokenPepper(env['TOKEN_PEPPER']), undefined),
});
