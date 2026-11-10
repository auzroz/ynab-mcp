/**
 * Hashed storage of MCP tokens, authorization codes, pending-authorization
 * state and DCR client secrets (#52).
 *
 * Nothing a client presents is stored. Each credential is looked up by a
 * storage key derived from it, so a copy of the database holds no usable
 * value:
 *
 *   - Issued values are `ymcp1_<rand>_<tag>`: 32 random bytes (43 base64url
 *     characters) and a 16-byte tag (22 base64url characters), an HMAC over the
 *     kind and `rand` under a key derived from the pepper. The tag is checked
 *     in constant time before any storage read, so a guessed or malformed value
 *     costs no lookup, and a value of one kind (an access token) presented as
 *     another (a refresh token) fails the same way.
 *   - The storage key is `h1.` + hex(HMAC-SHA256(k_h1, kind, value)), with
 *     `k_h1` derived from the pepper. One key per kind, so the same value can't
 *     address another table's row.
 *   - A value in the exact 0.4.x shape (`^[A-Za-z0-9_-]{43}$`: 32 random bytes
 *     as base64url, untagged) is still accepted and hashed the same way; the
 *     M3 migration rewrote every such stored key to its `h1.` form, so these
 *     still find their rows. Every other shape, including a stored `h1.` key
 *     presented verbatim, is refused before storage. There is no plaintext
 *     lookup anywhere.
 *   - DCR client secrets are stored as `s256.<hex SHA-256>`, without the pepper
 *     (they are 32 random bytes already, so the hash is not guessable).
 *
 * The pepper is `TOKEN_PEPPER` when set, otherwise derived from
 * `ENCRYPTION_KEY` with HKDF. Its fingerprint, HMAC(pepper,
 * "ynab-mcp/pepper-check"), is recorded in `schema_meta` at the first start,
 * and a later start with another pepper is refused (the stored keys would all
 * miss, silently logging everyone out).
 *
 * Nothing here logs, and no error carries a value, a key or the pepper.
 */

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseKey32 } from '../crypto.js';

/** What a credential is for; part of both the tag and the storage key. */
export type TokenKind = 'access' | 'refresh' | 'code' | 'state';

/** Prefix of every value issued since 0.5.0. */
export const TOKEN_PREFIX = 'ymcp1_';

/** Prefix of every storage key derived from a credential. */
export const STORAGE_KEY_PREFIX = 'h1.';

/** Prefix of a stored DCR client secret hash. */
export const CLIENT_SECRET_HASH_PREFIX = 's256.';

/** The exact shape of a 0.4.x token, code or state: 32 random bytes as base64url. */
export const LEGACY_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** An issued value: prefix, 43-character random part, `_`, 22-character tag. */
const ISSUED_TOKEN_SHAPE = /^ymcp1_([A-Za-z0-9_-]{43})_([A-Za-z0-9_-]{22})$/;

/** A stored client-secret hash: prefix and 64 lowercase hex digits. */
const CLIENT_SECRET_HASH_SHAPE = /^s256\.[0-9a-f]{64}$/;

const RANDOM_BYTES = 32;
const TAG_BYTES = 16;

/** HKDF info strings: one per derived key, so no two uses share a key. */
const PEPPER_FROM_ENCRYPTION_KEY = 'ynab-mcp/token-pepper/v1';
const TAG_KEY_INFO = 'ynab-mcp/ymcp1-tag';
const STORAGE_KEY_INFO = 'ynab-mcp/h1-key';
/** The fingerprint message the plan fixes: HMAC(pepper, "ynab-mcp/pepper-check"). */
const FINGERPRINT_MESSAGE = 'ynab-mcp/pepper-check';

function hkdf32(ikm: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
}

/** Constant-time equality of two strings (false, still in constant time per length, when lengths differ). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against itself so the work doesn't depend on where they differ.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** What the storage migration (M3) needs from the hasher; storage imports only this type. */
export interface TokenKeyDeriver {
  /** The `h1.` key of a 0.4.x value of `kind`; undefined when `value` isn't in the 0.4.x shape. */
  legacyStorageKey(kind: TokenKind, value: string): string | undefined;
  /** `s256.<hex>` of a plaintext client secret. */
  clientSecretHash(secret: string): string;
  /** HMAC(pepper, "ynab-mcp/pepper-check"), hex. Stored, never logged. */
  readonly fingerprint: string;
  /** Whether a stored fingerprint is this pepper's, compared in constant time. */
  fingerprintMatches(stored: string): boolean;
}

/** Where the pepper comes from. */
export interface PepperSource {
  /** `TOKEN_PEPPER`: 32 bytes as base64 or 64 hex characters. */
  tokenPepper?: string | undefined;
  /** `ENCRYPTION_KEY`, the fallback (HKDF). */
  encryptionKey?: string | undefined;
}

export class TokenHasher implements TokenKeyDeriver {
  private readonly tagKey: Buffer;
  private readonly storageKeyKey: Buffer;
  readonly fingerprint: string;

  /** `pepper`: 32 secret bytes. Use {@link TokenHasher.fromSecrets} for the configured one. */
  constructor(pepper: Buffer) {
    if (pepper.length !== 32) throw new Error('The token pepper must be 32 bytes');
    this.tagKey = hkdf32(pepper, TAG_KEY_INFO);
    this.storageKeyKey = hkdf32(pepper, STORAGE_KEY_INFO);
    this.fingerprint = createHmac('sha256', pepper).update(FINGERPRINT_MESSAGE).digest('hex');
  }

  /**
   * The configured hasher: `TOKEN_PEPPER` when set, otherwise a pepper derived
   * from `ENCRYPTION_KEY` (HKDF-SHA256). Throws, naming only the variable, when
   * neither is usable.
   */
  static fromSecrets(source: PepperSource): TokenHasher {
    if (source.tokenPepper !== undefined && source.tokenPepper.trim() !== '') {
      return new TokenHasher(parseKey32(source.tokenPepper, 'TOKEN_PEPPER'));
    }
    const encryptionKey = parseKey32(source.encryptionKey, 'ENCRYPTION_KEY');
    return new TokenHasher(hkdf32(encryptionKey, PEPPER_FROM_ENCRYPTION_KEY));
  }

  private tag(kind: TokenKind, rand: string): string {
    return createHmac('sha256', this.tagKey)
      .update(`${kind}\0${rand}`)
      .digest()
      .subarray(0, TAG_BYTES)
      .toString('base64url');
  }

  private storageKey(kind: TokenKind, value: string): string {
    const mac = createHmac('sha256', this.storageKeyKey).update(`${kind}\0${value}`).digest('hex');
    return `${STORAGE_KEY_PREFIX}${mac}`;
  }

  /** A new value of `kind` for the client, and the key to store it under. */
  issue(kind: TokenKind): { value: string; key: string } {
    const rand = randomBytes(RANDOM_BYTES).toString('base64url');
    const value = `${TOKEN_PREFIX}${rand}_${this.tag(kind, rand)}`;
    return { value, key: this.storageKey(kind, value) };
  }

  /**
   * The storage key for a value a client presented as `kind`, or undefined when
   * it must be refused without a storage read: anything but a correctly tagged
   * `ymcp1_` value of this kind or a 0.4.x-shaped one. A stored `h1.` key
   * presented verbatim is refused here.
   */
  keyFor(kind: TokenKind, presented: unknown): string | undefined {
    if (typeof presented !== 'string') return undefined;
    const issued = ISSUED_TOKEN_SHAPE.exec(presented);
    if (issued) {
      const rand = issued[1] as string;
      const tag = issued[2] as string;
      return constantTimeEqual(tag, this.tag(kind, rand)) ? this.storageKey(kind, presented) : undefined;
    }
    return this.legacyStorageKey(kind, presented);
  }

  legacyStorageKey(kind: TokenKind, value: string): string | undefined {
    return LEGACY_TOKEN_SHAPE.test(value) ? this.storageKey(kind, value) : undefined;
  }

  clientSecretHash(secret: string): string {
    return hashClientSecret(secret);
  }

  /** Whether `stored` (from `schema_meta`) is this pepper's fingerprint, in constant time. */
  fingerprintMatches(stored: string): boolean {
    return constantTimeEqual(stored, this.fingerprint);
  }
}

/** `s256.` + hex SHA-256 of a client secret (no pepper; see the file comment). */
export function hashClientSecret(secret: string): string {
  return `${CLIENT_SECRET_HASH_PREFIX}${createHash('sha256').update(secret, 'utf8').digest('hex')}`;
}

/** Whether `value` is a well-formed stored client-secret hash. */
export function isClientSecretHash(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SECRET_HASH_SHAPE.test(value);
}

/**
 * Whether a presented client secret matches a stored `s256.` hash, compared in
 * constant time. A presented value in the hash's own format (or any `s256.`
 * value) is refused, so a stored hash copied out of the database is never a
 * credential. A malformed stored value never matches.
 */
export function verifyClientSecret(presented: string, stored: string): boolean {
  if (presented.startsWith(CLIENT_SECRET_HASH_PREFIX)) return false;
  if (!isClientSecretHash(stored)) return false;
  return constantTimeEqual(hashClientSecret(presented), stored);
}
