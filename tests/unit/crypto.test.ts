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

  describe('GCM tag and IV checks', () => {
    const key = parseEncryptionKey(keyB64);

    function parts(token: string): string[] {
      return token.split('.');
    }

    it('writes a 12-byte IV and a 16-byte tag', () => {
      const [, iv, tag] = parts(encrypt('secret', key));
      expect(Buffer.from(iv as string, 'base64url')).toHaveLength(12);
      expect(Buffer.from(tag as string, 'base64url')).toHaveLength(16);
    });

    it.each([4, 8, 12, 15])('rejects a tag truncated to %i bytes', (length) => {
      const p = parts(encrypt('secret', key));
      const short = Buffer.from(p[2] as string, 'base64url').subarray(0, length);
      const forged = [p[0], p[1], short.toString('base64url'), p[3]].join('.');
      expect(() => decrypt(forged, key)).toThrow(/format/i);
    });

    it('rejects an empty and an oversized tag', () => {
      const p = parts(encrypt('secret', key));
      const empty = [p[0], p[1], '', p[3]].join('.');
      expect(() => decrypt(empty, key)).toThrow(/format/i);
      const long = Buffer.concat([Buffer.from(p[2] as string, 'base64url'), Buffer.alloc(4)]);
      expect(() => decrypt([p[0], p[1], long.toString('base64url'), p[3]].join('.'), key)).toThrow(
        /format/i
      );
    });

    it.each([0, 8, 11, 13, 16])('rejects a %i-byte IV', (length) => {
      const p = parts(encrypt('secret', key));
      const iv = randomBytes(length).toString('base64url');
      expect(() => decrypt([p[0], iv, p[2], p[3]].join('.'), key)).toThrow(/format/i);
    });

    it('still fails authentication for a right-sized but wrong tag', () => {
      const p = parts(encrypt('secret', key));
      const wrong = randomBytes(16).toString('base64url');
      expect(() => decrypt([p[0], p[1], wrong, p[3]].join('.'), key)).toThrow();
    });

    it('does not decrypt under another key', () => {
      const token = encrypt('secret', key);
      expect(() => decrypt(token, parseEncryptionKey(randomBytes(32).toString('base64')))).toThrow();
    });
  });
});
