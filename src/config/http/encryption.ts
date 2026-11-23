/**
 * At-rest key rotation settings (#57b): `ENCRYPTION_KEY_ID` and
 * `ENCRYPTION_KEY_PREVIOUS`.
 *
 * `ENCRYPTION_KEY` is the current key, written under `ENCRYPTION_KEY_ID`
 * (default 1). `ENCRYPTION_KEY_PREVIOUS` lists other keys as `<id>:<key>`,
 * comma-separated, that are only decrypted with: the rekey job moves their
 * rows to the current key, then retires them (docs/REMOTE_HOSTING.md,
 * "Rotating ENCRYPTION_KEY"). Errors name the variable only, never a value.
 */

import { parseCurrentKeyId, parsePreviousKeys } from '../../crypto.js';
import type { HttpLoader } from './types.js';

export interface EncryptionSettings {
  /** `ENCRYPTION_KEY_ID`, raw (validated); undefined when unset (id 1). */
  encryptionKeyId: string | undefined;
  /** `ENCRYPTION_KEY_PREVIOUS`, raw (validated); undefined when unset or empty. */
  encryptionKeyPrevious: string | undefined;
}

export const loadEncryptionSettings: HttpLoader<EncryptionSettings> = ({ env, problems }) => {
  const keyIdRaw = env['ENCRYPTION_KEY_ID'] || undefined;
  const previousRaw = env['ENCRYPTION_KEY_PREVIOUS']?.trim() ? env['ENCRYPTION_KEY_PREVIOUS'] : undefined;
  return {
    encryptionKeyId: problems.capture(
      'ENCRYPTION_KEY_ID',
      () => {
        parseCurrentKeyId(keyIdRaw);
        return keyIdRaw;
      },
      undefined
    ),
    encryptionKeyPrevious: problems.capture(
      'ENCRYPTION_KEY_PREVIOUS',
      () => {
        parsePreviousKeys(previousRaw);
        return previousRaw;
      },
      undefined
    ),
  };
};
