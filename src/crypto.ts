/**
 * At-rest encryption for the users' YNAB refresh tokens (`users.encrypted_refresh_token`).
 *
 * This is the only thing encrypted at rest. MCP access tokens, refresh tokens,
 * authorization codes, pending-auth state and DCR client secrets are not
 * encrypted but hashed: storage holds only keys derived from them (see
 * src/auth/token-hash.ts), so a copy of the database holds no usable credential.
 *
 * AES-256-GCM using a deployer-provided key. The key comes from `ENCRYPTION_KEY`
 * as base64 (32 bytes) or a 64-char hex string. Ciphertext is serialized as
 * `v1.<iv>.<tag>.<ciphertext>` (each part base64url) so the format is versioned
 * and self-describing. The GCM tag is pinned to 16 bytes on both sides, and the
 * IV and tag lengths are checked before decrypting, so a shortened tag is never
 * accepted.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/**
 * Parse a 32-byte secret from an env value: 64 hex characters, or base64 that
 * decodes to exactly 32 bytes. Errors name `varName` and never echo the value.
 */
export function parseKey32(raw: string | undefined, varName: string): Buffer {
  if (!raw || raw.trim() === '') {
    throw new Error(`${varName} is required in HTTP/multi-user mode (32-byte base64 or 64-char hex)`);
  }
  const value = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    key = Buffer.from(value, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `${varName} must decode to 32 bytes (got ${key.length}); use a base64 32-byte or 64-char hex key`
    );
  }
  return key;
}

/** Parse and validate the encryption key from an env value. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  return parseKey32(raw, 'ENCRYPTION_KEY');
}

/** Encrypt a UTF-8 string; returns a versioned, self-describing token. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Decrypt a token produced by {@link encrypt}. Throws on tampering/format errors. */
export function decrypt(token: string, key: Buffer): string {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Invalid encrypted token format');
  }
  const iv = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const ct = Buffer.from(parts[3] as string, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted token format');
  }
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Small helper bundling a key so callers don't pass the Buffer around.
 */
export class Encryptor {
  private readonly key: Buffer;
  constructor(rawKey: string | undefined) {
    this.key = parseEncryptionKey(rawKey);
  }
  encrypt(plaintext: string): string {
    return encrypt(plaintext, this.key);
  }
  decrypt(token: string): string {
    return decrypt(token, this.key);
  }
}
