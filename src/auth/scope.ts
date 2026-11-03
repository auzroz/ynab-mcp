/**
 * Checked parsing of the per-grant access level read back from storage.
 *
 * `granted_scope` is a free TEXT column, so a hand-edited row, a value written
 * by a newer release or a corrupted value must never widen access. Only the
 * exact string `read-write` reads as read-write; everything else, including an
 * unknown string, a number or an object, reads as read-only (fail closed).
 * Every storage driver applies this at the read, so callers see a `GrantedScope`
 * they can trust.
 */

import type { GrantedScope } from '../storage/types.js';

/** A required access-level column: anything but exactly `read-write` is read-only. */
export function parseGrantedScope(value: unknown): GrantedScope {
  return value === 'read-write' ? 'read-write' : 'read-only';
}

/**
 * A nullable access-level column (codes and tokens saved before 0.4.0 have
 * none): NULL stays `undefined`, which callers already treat as read-only;
 * any other value is parsed with {@link parseGrantedScope}.
 */
export function parseOptionalGrantedScope(value: unknown): GrantedScope | undefined {
  return value === null || value === undefined ? undefined : parseGrantedScope(value);
}
