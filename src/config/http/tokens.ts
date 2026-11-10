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

export interface TokenConfig {
  /** `TOKEN_PEPPER`, validated; undefined when unset (the HKDF fallback applies). */
  tokenPepper: string | undefined;
}

export function loadTokenConfig(env: Record<string, string | undefined> = process.env): TokenConfig {
  const raw = env['TOKEN_PEPPER'];
  if (raw === undefined || raw === '') return { tokenPepper: undefined };
  // Blank but set is a mistake, not "unset": refuse it rather than fall back.
  if (raw.trim() === '') {
    throw new Error('Invalid TOKEN_PEPPER: must be 32 bytes as base64 or 64 hex characters.');
  }
  // Validate at load time, so a bad value stops startup with the other config errors.
  parseKey32(raw, 'TOKEN_PEPPER');
  return { tokenPepper: raw.trim() };
}
