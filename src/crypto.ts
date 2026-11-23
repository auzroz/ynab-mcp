/**
 * At-rest encryption for the users' YNAB refresh tokens (`users.encrypted_refresh_token`).
 *
 * This is the only thing encrypted at rest. MCP access tokens, refresh tokens,
 * authorization codes, pending-auth state and DCR client secrets are not
 * encrypted but hashed: storage holds only keys derived from them (see
 * src/auth/token-hash.ts), so a copy of the database holds no usable credential.
 *
 * AES-256-GCM (node:crypto, synchronous) with deployer-provided keys, each 32
 * bytes as base64 or 64 hex characters. Two formats, each part base64url:
 *
 *   - `v2.<kid>.<iv>.<tag>.<ct>` (#57b), written by every encryption. `kid` is
 *     the decimal key id: `ENCRYPTION_KEY` is id `ENCRYPTION_KEY_ID` (default
 *     1), and `ENCRYPTION_KEY_PREVIOUS` lists older keys as `<id>:<key>`,
 *     comma-separated, for decryption only. The additional authenticated data
 *     binds the ciphertext to where it is stored, {@link aadFor}:
 *     `ynab-mcp|<column>|v2|<subject>` (the column, and the user id the row
 *     belongs to), so a ciphertext copied into another user's row, or another
 *     column, fails to decrypt.
 *   - `v1.<iv>.<tag>.<ct>` (0.3.x to 0.4.x), no key id and no AAD. Still read,
 *     with key id 1, until the rekey job (src/auth/rekey-job.ts) has rewritten
 *     every row and retired it; then it is refused, so an old ciphertext
 *     planted from a backup can't bypass the AAD.
 *
 * The GCM tag is pinned to 16 bytes on both sides, and the IV and tag lengths
 * are checked before decrypting, so a shortened tag is never accepted.
 *
 * Errors never carry a key, a token or any part of one.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const V1 = 'v1';
const V2 = 'v2';

/** The largest key id accepted (fits every integer column and JSON number). */
export const MAX_KEY_ID = 999_999;

/** The key id a `v1` ciphertext was written with: the `ENCRYPTION_KEY` of 0.4.x. */
export const LEGACY_KEY_ID = 1;

/**
 * The columns a ciphertext can be bound to: part of the AAD, so a label is
 * fixed once written. Add a member for a new encrypted column (#48's shared
 * access token); never rename one.
 */
export const CIPHERTEXT_COLUMNS = ['users.encrypted_refresh_token'] as const;
export type CiphertextColumn = (typeof CIPHERTEXT_COLUMNS)[number];

/** The YNAB refresh token's column; the staged sign-in's copy carries the same binding. */
export const YNAB_REFRESH_TOKEN_COLUMN: CiphertextColumn = 'users.encrypted_refresh_token';

/** Where a ciphertext is stored: its column and the row's owner (the YNAB user id). */
export interface CipherContext {
  column: CiphertextColumn;
  subject: string;
}

const MAX_SUBJECT_LENGTH = 256;

/**
 * The AAD of a `v2` ciphertext: `ynab-mcp|<column>|v2|<subject>` as UTF-8.
 * The column is one of {@link CIPHERTEXT_COLUMNS} (no `|`) and the subject
 * must be non-empty, without `|` or control characters, so two different
 * contexts never give the same bytes. Throws (value-free) otherwise.
 */
export function aadFor(context: CipherContext): Buffer {
  const { column, subject } = context;
  if (!(CIPHERTEXT_COLUMNS as readonly string[]).includes(column)) {
    throw new Error('Unknown ciphertext column');
  }
  if (
    typeof subject !== 'string' ||
    subject === '' ||
    subject.length > MAX_SUBJECT_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[|\u0000-\u001f\u007f]/.test(subject)
  ) {
    throw new Error('Invalid ciphertext subject');
  }
  return Buffer.from(`ynab-mcp|${column}|${V2}|${subject}`, 'utf8');
}

/** The context of a user's YNAB refresh token (users row and staged sign-in alike). */
export function refreshTokenContext(userId: string): CipherContext {
  return { column: YNAB_REFRESH_TOKEN_COLUMN, subject: userId };
}

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

/** Parse a key id: a decimal integer from 1 to {@link MAX_KEY_ID}, no sign or leading zero. */
export function parseKeyId(raw: string | undefined, varName: string): number {
  const value = raw?.trim() ?? '';
  if (!/^[1-9]\d{0,5}$/.test(value)) {
    throw new Error(`${varName} must be a key id from 1 to ${MAX_KEY_ID}`);
  }
  return Number(value);
}

/** `ENCRYPTION_KEY_ID`: 1 when unset or empty. */
export function parseCurrentKeyId(raw: string | undefined): number {
  if (raw === undefined || raw === '') return LEGACY_KEY_ID;
  return parseKeyId(raw, 'ENCRYPTION_KEY_ID');
}

export interface KeyEntry {
  id: number;
  key: Buffer;
}

/**
 * `ENCRYPTION_KEY_PREVIOUS`: `<id>:<key>` entries, comma-separated (base64
 * has no `:` or `,`). Empty or unset is none. Errors name the variable and the
 * entry's position, never a value.
 */
export function parsePreviousKeys(raw: string | undefined): KeyEntry[] {
  if (raw === undefined || raw.trim() === '') return [];
  const out: KeyEntry[] = [];
  raw.split(',').forEach((entry, i) => {
    const at = entry.indexOf(':');
    const where = `ENCRYPTION_KEY_PREVIOUS entry ${i + 1}`;
    if (at < 0) throw new Error(`${where} must be <id>:<key>`);
    out.push({ id: parseKeyId(entry.slice(0, at), `${where}'s id`), key: parseKey32(entry.slice(at + 1), where) });
  });
  return out;
}

/** What {@link Encryptor} needs besides `ENCRYPTION_KEY`. */
export interface EncryptorOptions {
  /** `ENCRYPTION_KEY_ID` (raw); 1 when unset. */
  keyId?: string | undefined;
  /** `ENCRYPTION_KEY_PREVIOUS` (raw). */
  previousKeys?: string | undefined;
}

/**
 * The keyring: the current key and the previous ones. Throws (value-free) on
 * a duplicate id, the current id among the previous ones, or one key under
 * two ids (a mislabel would make one of them undecryptable).
 */
export function parseKeyring(rawKey: string | undefined, options: EncryptorOptions = {}): {
  current: KeyEntry;
  previous: KeyEntry[];
} {
  const current = { id: parseCurrentKeyId(options.keyId), key: parseEncryptionKey(rawKey) };
  const previous = parsePreviousKeys(options.previousKeys);
  const ids = new Set<number>([current.id]);
  const keys = new Set<string>([current.key.toString('hex')]);
  for (const entry of previous) {
    if (ids.has(entry.id)) {
      throw new Error(
        entry.id === current.id
          ? 'ENCRYPTION_KEY_PREVIOUS lists ENCRYPTION_KEY_ID; a previous key needs an id of its own'
          : 'ENCRYPTION_KEY_PREVIOUS lists a key id twice'
      );
    }
    if (keys.has(entry.key.toString('hex'))) {
      throw new Error('ENCRYPTION_KEY_PREVIOUS lists a key that is already configured under another id');
    }
    ids.add(entry.id);
    keys.add(entry.key.toString('hex'));
  }
  return { current, previous };
}

function seal(plaintext: string, key: Buffer, aad: Buffer | undefined): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function open(parts: { iv: string; tag: string; ct: string }, key: Buffer, aad: Buffer | undefined): string {
  const iv = Buffer.from(parts.iv, 'base64url');
  const tag = Buffer.from(parts.tag, 'base64url');
  const ct = Buffer.from(parts.ct, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted token format');
  }
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Encrypt a UTF-8 string in the `v2` format under key `kid`, bound to `context`. */
export function encryptV2(plaintext: string, key: Buffer, kid: number, context: CipherContext): string {
  const { iv, tag, ct } = seal(plaintext, key, aadFor(context));
  return [V2, String(kid), iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * Encrypt in the legacy `v1` format (no key id, no AAD). Only tests and the
 * migration tests write it; the server never does.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const { iv, tag, ct } = seal(plaintext, key, undefined);
  return [V1, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Decrypt a legacy `v1` token. Throws on tampering or a format error. */
export function decrypt(token: string, key: Buffer): string {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== V1) {
    throw new Error('Invalid encrypted token format');
  }
  return open({ iv: parts[1] as string, tag: parts[2] as string, ct: parts[3] as string }, key, undefined);
}

/** A stored ciphertext's format and key id, or undefined when it is in neither format. */
export function ciphertextVersion(token: string): { format: 'v1' } | { format: 'v2'; kid: number } | undefined {
  const parts = token.split('.');
  if (parts.length === 4 && parts[0] === V1) return { format: 'v1' };
  if (parts.length === 5 && parts[0] === V2 && /^[1-9]\d{0,5}$/.test(parts[1] as string)) {
    return { format: 'v2', kid: Number(parts[1]) };
  }
  return undefined;
}

/** The fixed message a key's check value is computed over (stored in `schema_meta`, never logged). */
const KEY_CHECK_MESSAGE = 'ynab-mcp/encryption-key-check';

/**
 * The keyring the server encrypts and decrypts with. Synchronous (node:crypto):
 * #57b keeps this API, and the WebCrypto port the issue considered is not done
 * (D-6(d)).
 */
export class Encryptor {
  private readonly current: KeyEntry;
  private readonly keys: Map<number, Buffer>;
  private floor = 0;

  constructor(rawKey: string | undefined, options: EncryptorOptions = {}) {
    const { current, previous } = parseKeyring(rawKey, options);
    this.current = current;
    this.keys = new Map([[current.id, current.key], ...previous.map((e): [number, Buffer] => [e.id, e.key])]);
  }

  /** The id new ciphertexts are written with (`ENCRYPTION_KEY_ID`). */
  get currentKeyId(): number {
    return this.current.id;
  }

  /** Every configured key id, current first. */
  get keyIds(): number[] {
    return [...this.keys.keys()];
  }

  /** The prefix every ciphertext written now starts with: `v2.<kid>.`. */
  get currentPrefix(): string {
    return `${V2}.${this.current.id}.`;
  }

  /** The retirement floor in force: `v1` and key ids below it are refused (0: none retired). */
  get retiredBelow(): number {
    return this.floor;
  }

  /**
   * Refuse, from now on, the legacy `v1` format and every key id below
   * `floor` (the rekey job's marker, `schema_meta.encryption_retired_below`).
   * Never lowers it. Throws when it would retire the current key.
   */
  retireBelow(floor: number): void {
    if (floor > this.current.id) {
      throw new Error(
        'ENCRYPTION_KEY_ID is older than the keys this database has already moved to; ' +
          'set ENCRYPTION_KEY and ENCRYPTION_KEY_ID to the newest key (see "Rotating ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md)'
      );
    }
    if (floor > this.floor) this.floor = floor;
  }

  /** Whether `token` was written with the current key in the current format. */
  isCurrent(token: string): boolean {
    return token.startsWith(this.currentPrefix) && ciphertextVersion(token) !== undefined;
  }

  /**
   * Encrypt a UTF-8 string with the current key, bound to `context`. The
   * context is optional in the signature only so callers written before
   * #57b keep compiling; a call without one throws, so no unbound ciphertext
   * is ever written.
   */
  encrypt(plaintext: string, context?: CipherContext): string {
    if (context === undefined) throw new Error('Encryptor.encrypt needs the ciphertext context (#57b)');
    return encryptV2(plaintext, this.current.key, this.current.id, context);
  }

  /**
   * Decrypt a stored token. A `v2` token needs the context it was written
   * with (a call without one throws) and a configured, unretired key id; a
   * `v1` token is read with key id 1, until `v1` is retired. Throws on any
   * mismatch, tampering or format error, naming no value.
   */
  decrypt(token: string, context?: CipherContext): string {
    const version = ciphertextVersion(token);
    if (version === undefined) throw new Error('Invalid encrypted token format');
    if (version.format === 'v1') {
      if (this.floor > 0) throw new Error('Encrypted token is in a retired format');
      const key = this.keys.get(LEGACY_KEY_ID);
      if (!key) throw new Error('No configured key for this encrypted token');
      return decrypt(token, key);
    }
    if (context === undefined) throw new Error('Encryptor.decrypt needs the ciphertext context (#57b)');
    if (version.kid < this.floor) throw new Error('Encrypted token uses a retired key');
    const key = this.keys.get(version.kid);
    if (!key) throw new Error('No configured key for this encrypted token');
    const parts = token.split('.');
    return open({ iv: parts[2] as string, tag: parts[3] as string, ct: parts[4] as string }, key, aadFor(context));
  }

  /**
   * Each configured key's check value, HMAC-SHA256(key, fixed message) as hex:
   * recorded per id in `schema_meta` at first use, so a key replaced under the
   * same id is refused at startup instead of failing every user's refresh.
   * Reveals nothing about the key.
   */
  keyChecks(): Array<{ id: number; check: string }> {
    return [...this.keys].map(([id, key]) => ({
      id,
      check: createHmac('sha256', key).update(KEY_CHECK_MESSAGE).digest('hex'),
    }));
  }
}
