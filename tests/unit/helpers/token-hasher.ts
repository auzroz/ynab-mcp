/**
 * The token hasher tests share (#52).
 *
 * Durable storage checks the pepper fingerprint at every init, and test files
 * that share one Postgres schema (or reopen one SQLite file) must all present
 * the same pepper, so every test that opens storage uses this fixed one. A
 * test that needs another pepper uses its own database or schema.
 */

import { randomBytes } from 'node:crypto';
import { TokenHasher, type TokenKind } from '../../../src/auth/token-hash.js';

/** A fixed, test-only pepper (not a secret: it protects nothing). */
export const TEST_TOKEN_PEPPER = Buffer.alloc(32, 7).toString('base64');

export const TEST_TOKEN_HASHER = TokenHasher.fromSecrets({ tokenPepper: TEST_TOKEN_PEPPER });

/** The storage key a value presented as `kind` maps to under the test pepper; throws when it would be refused. */
export function testKey(kind: TokenKind, value: string): string {
  const key = TEST_TOKEN_HASHER.keyFor(kind, value);
  if (key === undefined) throw new Error(`testKey: a ${kind} value of this shape is refused`);
  return key;
}

/** A value in the exact 0.4.x shape (32 random bytes as base64url, 43 characters). */
export function legacyToken(): string {
  return randomBytes(32).toString('base64url');
}
