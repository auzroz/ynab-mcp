/**
 * At-rest encryption (AES-256-GCM) round-trip + validation.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  Encryptor,
  aadFor,
  ciphertextVersion,
  encrypt,
  decrypt,
  parseEncryptionKey,
  parseKeyring,
  parsePreviousKeys,
  refreshTokenContext,
  accessTokenContext,
  CIPHERTEXT_COLUMNS,
  type CipherContext,
} from '../../src/crypto.js';

const keyB64 = randomBytes(32).toString('base64');
const ctx = refreshTokenContext('user-a');

describe('crypto', () => {
  it('round-trips a secret in the v2 format, under key id 1 by default', () => {
    const enc = new Encryptor(keyB64);
    const secret = 'ynab-refresh-token-abc123';
    const token = enc.encrypt(secret, ctx);
    expect(token).not.toContain(secret);
    expect(token.startsWith('v2.1.')).toBe(true);
    expect(token.split('.')).toHaveLength(5);
    expect(enc.isCurrent(token)).toBe(true);
    expect(enc.decrypt(token, ctx)).toBe(secret);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const enc = new Encryptor(keyB64);
    expect(enc.encrypt('same', ctx)).not.toBe(enc.encrypt('same', ctx));
  });

  it('accepts a 64-char hex key', () => {
    const hex = randomBytes(32).toString('hex');
    const enc = new Encryptor(hex);
    expect(enc.decrypt(enc.encrypt('x', ctx), ctx)).toBe('x');
  });

  describe('AAD binding (#57b)', () => {
    it('is ynab-mcp|<column>|v2|<subject>', () => {
      expect(aadFor(ctx).toString('utf8')).toBe('ynab-mcp|users.encrypted_refresh_token|v2|user-a');
    });

    it("pins every column label: they are part of every stored ciphertext (#48's shared access token too)", () => {
      expect(CIPHERTEXT_COLUMNS).toEqual(['users.encrypted_refresh_token', 'users.encrypted_access_token']);
      expect(aadFor(accessTokenContext('user-a')).toString('utf8')).toBe('ynab-mcp|users.encrypted_access_token|v2|user-a');
      // A refresh-token ciphertext does not open as the same user's access token, nor the reverse.
      const enc = new Encryptor(keyB64);
      expect(() => enc.decrypt(enc.encrypt('x', ctx), accessTokenContext('user-a'))).toThrow();
      expect(() => enc.decrypt(enc.encrypt('x', accessTokenContext('user-a')), ctx)).toThrow();
    });

    it("refuses another user's ciphertext (a swapped row)", () => {
      const enc = new Encryptor(keyB64);
      const token = enc.encrypt('secret', refreshTokenContext('user-a'));
      expect(() => enc.decrypt(token, refreshTokenContext('user-b'))).toThrow();
    });

    it('refuses a ciphertext moved to another column', () => {
      const enc = new Encryptor(keyB64);
      const token = enc.encrypt('secret', ctx);
      const other = { column: 'users.other_column', subject: 'user-a' } as unknown as CipherContext;
      expect(() => enc.decrypt(token, other)).toThrow(/column/);
    });

    it('needs a context to encrypt, and to decrypt v2, even from a caller past the types', () => {
      // The context is required in the signatures; a cast (or plain JS) still throws at runtime.
      const untyped = new Encryptor(keyB64) as unknown as {
        encrypt(plaintext: string, context?: CipherContext): string;
        decrypt(token: string, context?: CipherContext): string;
      };
      expect(() => untyped.encrypt('secret')).toThrow(/context/);
      expect(() => untyped.decrypt(untyped.encrypt('secret', ctx))).toThrow(/context/);
    });

    it.each(['', 'a|b', 'line\nbreak', 'x'.repeat(257)])('refuses the subject %j', (subject) => {
      expect(() => aadFor({ column: 'users.encrypted_refresh_token', subject })).toThrow(/subject/);
    });

    it('rejects a truncated tag in the v2 format too', () => {
      const enc = new Encryptor(keyB64);
      const p = enc.encrypt('secret', ctx).split('.');
      const short = Buffer.from(p[3] as string, 'base64url').subarray(0, 12).toString('base64url');
      expect(() => enc.decrypt([p[0], p[1], p[2], short, p[4]].join('.'), ctx)).toThrow(/format/i);
    });

    it('refuses a key id that was edited in the ciphertext', () => {
      const k2 = randomBytes(32).toString('base64');
      const enc = new Encryptor(k2, { keyId: '2', previousKeys: `1:${keyB64}` });
      const p = enc.encrypt('secret', ctx).split('.');
      expect(() => enc.decrypt(['v2', '1', ...p.slice(2)].join('.'), ctx)).toThrow();
    });
  });

  describe('keyring and rotation (#57b)', () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('hex');

    it('keeps every row readable through a rotation: v1, old key id, new key id', () => {
      const legacy = encrypt('legacy', parseEncryptionKey(k1));
      const before = new Encryptor(k1);
      const underOne = before.encrypt('one', ctx);

      const after = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` });
      expect(after.decrypt(legacy, ctx)).toBe('legacy');
      // v1 has no binding: the context is accepted and ignored.
      expect(after.decrypt(legacy, refreshTokenContext('someone-else'))).toBe('legacy');
      expect(after.decrypt(underOne, ctx)).toBe('one');
      const underTwo = after.encrypt('two', ctx);
      expect(underTwo.startsWith('v2.2.')).toBe(true);
      expect(after.decrypt(underTwo, ctx)).toBe('two');
      expect(after.isCurrent(underOne)).toBe(false);
      expect(after.isCurrent(underTwo)).toBe(true);
    });

    it('refuses v1 and older key ids once retired, and never lowers the floor', () => {
      const legacy = encrypt('legacy', parseEncryptionKey(k1));
      const underOne = new Encryptor(k1).encrypt('one', ctx);
      const enc = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` });
      enc.retireBelow(1);
      expect(() => enc.decrypt(legacy, ctx)).toThrow(/retired/);
      expect(enc.decrypt(underOne, ctx)).toBe('one');
      enc.retireBelow(2);
      expect(() => enc.decrypt(underOne, ctx)).toThrow(/retired/);
      enc.retireBelow(0);
      expect(enc.retiredBelow).toBe(2);
    });

    it('refuses a floor above the current key id', () => {
      const enc = new Encryptor(k1);
      expect(() => enc.retireBelow(2)).toThrow(/ENCRYPTION_KEY_ID/);
    });

    it('fails for a key id that is not configured', () => {
      const underTwo = new Encryptor(k2, { keyId: '2' }).encrypt('two', ctx);
      expect(() => new Encryptor(k1).decrypt(underTwo, ctx)).toThrow(/No configured key/);
      // v1 needs key id 1.
      const legacy = encrypt('legacy', parseEncryptionKey(k1));
      expect(() => new Encryptor(k2, { keyId: '2' }).decrypt(legacy, ctx)).toThrow(/No configured key/);
    });

    it('parses ENCRYPTION_KEY_PREVIOUS', () => {
      expect(parsePreviousKeys(undefined)).toEqual([]);
      expect(parsePreviousKeys('  ')).toEqual([]);
      const parsed = parsePreviousKeys(`1:${k1}, 3:${k2}`);
      expect(parsed.map((e) => e.id)).toEqual([1, 3]);
    });

    it.each([
      ['no separator', () => parsePreviousKeys(k1), /entry 1 must be <id>:<key>/],
      ['a bad id', () => parsePreviousKeys(`0:${k1}`), /entry 1's id/],
      ['a short key', () => parsePreviousKeys(`1:${k1},2:abcd`), /entry 2 must decode to 32 bytes/],
      ['the current id', () => parseKeyring(k2, { keyId: '1', previousKeys: `1:${k1}` }), /needs an id of its own/],
      ['an id twice', () => parseKeyring(k2, { keyId: '3', previousKeys: `1:${k1},1:${randomBytes(32).toString('base64')}` }), /twice/],
      ['one key under two ids', () => parseKeyring(k1, { keyId: '2', previousKeys: `1:${k1}` }), /another id/],
      ['a bad ENCRYPTION_KEY_ID', () => parseKeyring(k1, { keyId: '01' }), /ENCRYPTION_KEY_ID/],
    ])('refuses %s, without echoing a value', (_name, run, pattern) => {
      let message = '';
      try {
        run();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      for (const secret of [k1, k2]) expect(message).not.toContain(secret);
    });

    it('reads the format and key id of a stored ciphertext', () => {
      const enc = new Encryptor(k2, { keyId: '42' });
      expect(ciphertextVersion(enc.encrypt('x', ctx))).toEqual({ format: 'v2', kid: 42 });
      expect(ciphertextVersion(encrypt('x', parseEncryptionKey(k1)))).toEqual({ format: 'v1' });
      expect(ciphertextVersion('v2.0.a.b.c')).toBeUndefined();
      expect(ciphertextVersion('garbage')).toBeUndefined();
    });

    it('gives each key a stable check value that reveals no key', () => {
      const a = new Encryptor(k2, { keyId: '2', previousKeys: `1:${k1}` }).keyChecks();
      const b = new Encryptor(k1).keyChecks();
      expect(a.map((c) => c.id)).toEqual([2, 1]);
      expect(a.find((c) => c.id === 1)?.check).toBe(b[0]?.check);
      for (const { check } of a) {
        expect(check).toMatch(/^[0-9a-f]{64}$/);
        expect(check).not.toContain(Buffer.from(k1, 'base64').toString('hex'));
      }
    });
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

    /** decrypt fails, and the message names none of the token, its segments or the key. */
    function expectDecryptError(token: string, using: Buffer = key, pattern?: RegExp): void {
      let message: string | undefined;
      try {
        decrypt(token, using);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBeDefined();
      if (pattern) expect(message).toMatch(pattern);
      const secrets = [
        token,
        ...parts(token).filter((s) => s.length > 3),
        keyB64,
        using.toString('hex'),
        using.toString('base64'),
      ];
      for (const secret of secrets) expect(message).not.toContain(secret);
      expect(message).not.toMatch(/[/\\](?:Users|home|src|node_modules)[/\\]/);
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
      expectDecryptError(forged, key, /format/i);
    });

    it('rejects an empty and an oversized tag', () => {
      const p = parts(encrypt('secret', key));
      const empty = [p[0], p[1], '', p[3]].join('.');
      expectDecryptError(empty, key, /format/i);
      const long = Buffer.concat([Buffer.from(p[2] as string, 'base64url'), Buffer.alloc(4)]);
      expectDecryptError([p[0], p[1], long.toString('base64url'), p[3]].join('.'), key, /format/i);
    });

    it.each([0, 8, 11, 13, 16])('rejects a %i-byte IV', (length) => {
      const p = parts(encrypt('secret', key));
      const iv = randomBytes(length).toString('base64url');
      expectDecryptError([p[0], iv, p[2], p[3]].join('.'), key, /format/i);
    });

    it('still fails authentication for a right-sized but wrong tag', () => {
      const p = parts(encrypt('secret', key));
      const wrong = randomBytes(16).toString('base64url');
      expectDecryptError([p[0], p[1], wrong, p[3]].join('.'));
    });

    it('does not decrypt under another key', () => {
      const token = encrypt('secret', key);
      expectDecryptError(token, parseEncryptionKey(randomBytes(32).toString('base64')));
    });
  });
});
