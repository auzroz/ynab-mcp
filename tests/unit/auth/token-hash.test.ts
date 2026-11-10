/**
 * TokenHasher (#52): the issued format, the tag check before any storage
 * read, the 0.4.x shape, the pepper and its fallback, client-secret hashes,
 * and that every comparison of a secret goes through timingSafeEqual.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wrap timingSafeEqual so the tests can see that comparisons go through it.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CLIENT_SECRET_HASH_PREFIX,
  LEGACY_TOKEN_SHAPE,
  STORAGE_KEY_PREFIX,
  TOKEN_PREFIX,
  TokenHasher,
  constantTimeEqual,
  hashClientSecret,
  isClientSecretHash,
  verifyClientSecret,
  type TokenKind,
} from '../../../src/auth/token-hash.js';

const timingSafe = vi.mocked(timingSafeEqual);
const KINDS: readonly TokenKind[] = ['access', 'refresh', 'code', 'state'];
const pepper = (): string => randomBytes(32).toString('base64');
const hasher = TokenHasher.fromSecrets({ tokenPepper: pepper() });

beforeEach(() => {
  timingSafe.mockClear();
});

describe('issued values', () => {
  it.each(KINDS)('a %s value is ymcp1_<43>_<22> and maps to its h1. key', (kind) => {
    const { value, key } = hasher.issue(kind);
    expect(value).toMatch(/^ymcp1_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{22}$/);
    expect(value.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(key).toMatch(/^h1\.[0-9a-f]{64}$/);
    expect(key.startsWith(STORAGE_KEY_PREFIX)).toBe(true);
    expect(key).not.toContain(value);
    expect(hasher.keyFor(kind, value)).toBe(key);
  });

  it('issues a different value and key every time', () => {
    const a = hasher.issue('access');
    const b = hasher.issue('access');
    expect(a.value).not.toBe(b.value);
    expect(a.key).not.toBe(b.key);
  });

  it('refuses a value presented as another kind (the tag binds the kind)', () => {
    for (const kind of KINDS) {
      const { value } = hasher.issue(kind);
      for (const other of KINDS.filter((k) => k !== kind)) expect(hasher.keyFor(other, value)).toBeUndefined();
    }
  });

  it('refuses a value whose tag or random part was changed', () => {
    const { value } = hasher.issue('access');
    const flip = (s: string, i: number): string => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    expect(hasher.keyFor('access', flip(value, value.length - 1))).toBeUndefined();
    expect(hasher.keyFor('access', flip(value, TOKEN_PREFIX.length))).toBeUndefined();
  });

  it('refuses a correctly shaped value with a guessed tag, after a constant-time comparison', () => {
    const forged = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}_${randomBytes(16).toString('base64url')}`;
    expect(forged).toMatch(/^ymcp1_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{22}$/);
    expect(hasher.keyFor('access', forged)).toBeUndefined();
    expect(timingSafe).toHaveBeenCalled();
  });

  it("refuses another pepper's value", () => {
    const other = TokenHasher.fromSecrets({ tokenPepper: pepper() });
    expect(hasher.keyFor('refresh', other.issue('refresh').value)).toBeUndefined();
  });
});

describe('presented values that never reach storage', () => {
  const issued = hasher.issue('access');
  it.each([
    ['a stored h1. key presented verbatim', issued.key],
    ['an s256. client-secret hash', hashClientSecret('x')],
    ['the empty string', ''],
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['43 characters with a dot', `${'a'.repeat(42)}.`],
    ['43 characters of standard base64', `${'a'.repeat(41)}+/`],
    ['43 characters with padding', `${'a'.repeat(42)}=`],
    ['the prefix only', TOKEN_PREFIX],
    ['an issued value with a trailing newline', `${issued.value}\n`],
    ['an issued value with a short tag', issued.value.slice(0, -1)],
  ])('refuses %s', (_name, value) => {
    for (const kind of KINDS) expect(hasher.keyFor(kind, value)).toBeUndefined();
  });

  it.each([undefined, null, 42, {}, ['x']])('refuses a non-string (%s)', (value) => {
    expect(hasher.keyFor('access', value)).toBeUndefined();
  });
});

describe('0.4.x values', () => {
  it('accepts exactly the 0.4.x shape and hashes it the same way per kind', () => {
    const legacy = randomBytes(32).toString('base64url');
    expect(legacy).toMatch(LEGACY_TOKEN_SHAPE);
    const keys = KINDS.map((kind) => hasher.keyFor(kind, legacy));
    for (const [i, kind] of KINDS.entries()) {
      expect(keys[i]).toMatch(/^h1\.[0-9a-f]{64}$/);
      expect(hasher.legacyStorageKey(kind, legacy)).toBe(keys[i]);
    }
    // One key per kind: a value can't address another table's row.
    expect(new Set(keys).size).toBe(KINDS.length);
  });

  it('gives no legacy key for anything else', () => {
    expect(hasher.legacyStorageKey('access', hasher.issue('access').value)).toBeUndefined();
    expect(hasher.legacyStorageKey('access', 'short')).toBeUndefined();
  });
});

describe('pepper', () => {
  it('derives the same keys and fingerprint from the same TOKEN_PEPPER', () => {
    const p = pepper();
    const a = TokenHasher.fromSecrets({ tokenPepper: p });
    const b = TokenHasher.fromSecrets({ tokenPepper: Buffer.from(p, 'base64').toString('hex') });
    const legacy = randomBytes(32).toString('base64url');
    expect(b.keyFor('access', legacy)).toBe(a.keyFor('access', legacy));
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.keyFor('access', a.issue('access').value)).toBeDefined();
  });

  it('falls back to a pepper derived from ENCRYPTION_KEY, which TOKEN_PEPPER overrides', () => {
    const encryptionKey = pepper();
    const fallback = TokenHasher.fromSecrets({ encryptionKey });
    expect(TokenHasher.fromSecrets({ encryptionKey }).fingerprint).toBe(fallback.fingerprint);
    // HKDF, not the key itself: the same bytes as an explicit pepper differ.
    expect(TokenHasher.fromSecrets({ tokenPepper: encryptionKey }).fingerprint).not.toBe(fallback.fingerprint);
    expect(TokenHasher.fromSecrets({ tokenPepper: pepper(), encryptionKey }).fingerprint).not.toBe(
      fallback.fingerprint
    );
    expect(TokenHasher.fromSecrets({ tokenPepper: '', encryptionKey }).fingerprint).toBe(fallback.fingerprint);
  });

  it('changes every key and the fingerprint with the pepper', () => {
    const a = TokenHasher.fromSecrets({ tokenPepper: pepper() });
    const b = TokenHasher.fromSecrets({ tokenPepper: pepper() });
    const legacy = randomBytes(32).toString('base64url');
    expect(a.keyFor('refresh', legacy)).not.toBe(b.keyFor('refresh', legacy));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprintMatches(b.fingerprint)).toBe(false);
    expect(a.fingerprintMatches(a.fingerprint)).toBe(true);
    expect(timingSafe).toHaveBeenCalled();
  });

  it('refuses an unusable pepper or key without echoing it', () => {
    const bad = 'not-a-32-byte-secret-value';
    expect(() => TokenHasher.fromSecrets({ tokenPepper: bad })).toThrow(/TOKEN_PEPPER must decode to 32 bytes/);
    expect(() => TokenHasher.fromSecrets({ encryptionKey: bad })).toThrow(/ENCRYPTION_KEY/);
    expect(() => TokenHasher.fromSecrets({})).toThrow(/ENCRYPTION_KEY is required/);
    for (const source of [{ tokenPepper: bad }, { encryptionKey: bad }]) {
      try {
        TokenHasher.fromSecrets(source);
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    }
    expect(() => new TokenHasher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('client secrets', () => {
  const secret = randomBytes(32).toString('hex');
  const stored = hashClientSecret(secret);

  it('stores s256.<hex SHA-256>, without the pepper', () => {
    expect(stored).toMatch(/^s256\.[0-9a-f]{64}$/);
    expect(stored.startsWith(CLIENT_SECRET_HASH_PREFIX)).toBe(true);
    expect(stored).not.toContain(secret);
    expect(hasher.clientSecretHash(secret)).toBe(stored);
    expect(TokenHasher.fromSecrets({ tokenPepper: pepper() }).clientSecretHash(secret)).toBe(stored);
    expect(isClientSecretHash(stored)).toBe(true);
    expect(isClientSecretHash(secret)).toBe(false);
    expect(isClientSecretHash(undefined)).toBe(false);
  });

  it('verifies the secret in constant time', () => {
    expect(verifyClientSecret(secret, stored)).toBe(true);
    expect(timingSafe).toHaveBeenCalled();
    expect(verifyClientSecret(`${secret}x`, stored)).toBe(false);
    expect(verifyClientSecret('', stored)).toBe(false);
  });

  it('never accepts the stored hash, or anything in its format, as the secret', () => {
    expect(verifyClientSecret(stored, stored)).toBe(false);
    expect(verifyClientSecret(`${CLIENT_SECRET_HASH_PREFIX}anything`, stored)).toBe(false);
    // Even a secret whose own value starts with the prefix: refused before hashing.
    const prefixed = `${CLIENT_SECRET_HASH_PREFIX}${secret}`;
    expect(verifyClientSecret(prefixed, hashClientSecret(prefixed))).toBe(false);
  });

  it('never matches a malformed stored value', () => {
    expect(verifyClientSecret(secret, secret)).toBe(false);
    expect(verifyClientSecret(secret, `${stored}0`)).toBe(false);
    expect(verifyClientSecret(secret, stored.toUpperCase())).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares with timingSafeEqual, also when the lengths differ', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    timingSafe.mockClear();
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafe).toHaveBeenCalledTimes(1);
  });
});
