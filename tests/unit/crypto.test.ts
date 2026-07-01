/**
 * At-rest encryption (AES-256-GCM) round-trip + validation.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Encryptor, encrypt, decrypt, parseEncryptionKey } from '../../src/crypto.js';

const keyB64 = randomBytes(32).toString('base64');

describe('crypto', () => {
  it('round-trips a secret', () => {
    const enc = new Encryptor(keyB64);
    const secret = 'ynab-refresh-token-abc123';
    const token = enc.encrypt(secret);
    expect(token).not.toContain(secret);
    expect(token.startsWith('v1.')).toBe(true);
    expect(enc.decrypt(token)).toBe(secret);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const enc = new Encryptor(keyB64);
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same'));
  });

  it('accepts a 64-char hex key', () => {
    const hex = randomBytes(32).toString('hex');
    const enc = new Encryptor(hex);
    expect(enc.decrypt(enc.encrypt('x'))).toBe('x');
  });

  it('rejects a missing or wrong-length key', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/required/i);
    expect(() => parseEncryptionKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });

  it('fails to decrypt tampered ciphertext', () => {
    const key = parseEncryptionKey(keyB64);
    const token = encrypt('secret', key);
    const parts = token.split('.');
    // Flip a byte in the ciphertext segment.
    const ctBuf = Buffer.from(parts[3] as string, 'base64url');
    ctBuf[0] = ctBuf[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ctBuf.toString('base64url')].join('.');
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('rejects malformed tokens', () => {
    const key = parseEncryptionKey(keyB64);
    expect(() => decrypt('not-a-token', key)).toThrow(/format/i);
  });
});
