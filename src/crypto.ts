/**
 * At-rest encryption for stored secrets (YNAB refresh tokens, MCP refresh tokens).
 *
 * AES-256-GCM using a deployer-provided key. The key comes from `ENCRYPTION_KEY`
 * as base64 (32 bytes) or a 64-char hex string. Ciphertext is serialized as
 * `v1.<iv>.<tag>.<ciphertext>` (each part base64url) so the format is versioned
 * and self-describing.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/** Parse and validate the encryption key from an env value. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new Error('ENCRYPTION_KEY is required in HTTP/multi-user mode (32-byte base64 or 64-char hex)');
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
      `ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}); use a base64 32-byte or 64-char hex key`
    );
  }
  return key;
}

/** Encrypt a UTF-8 string; returns a versioned, self-describing token. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
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
  const decipher = createDecipheriv(ALGO, key, iv);
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
