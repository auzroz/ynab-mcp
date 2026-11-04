/**
 * Checked parsing of the stored per-grant access level: only the exact string
 * `read-write` reads as read-write.
 */

import { describe, it, expect } from 'vitest';
import { parseGrantedScope, parseOptionalGrantedScope } from '../../../src/auth/scope.js';

describe('parseGrantedScope', () => {
  it('keeps the two known values', () => {
    expect(parseGrantedScope('read-write')).toBe('read-write');
    expect(parseGrantedScope('read-only')).toBe('read-only');
  });

  it.each([
    ['an unknown string', 'admin'],
    ['a different case', 'READ-WRITE'],
    ['padded', ' read-write'],
    ['a prefix match', 'read-write-all'],
    ['the empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an object', { scope: 'read-write' }],
    ['an array', ['read-write']],
  ])('reads %s as read-only', (_label, value) => {
    expect(parseGrantedScope(value)).toBe('read-only');
  });
});

describe('parseOptionalGrantedScope', () => {
  it('keeps a missing level missing (pre-0.4.0 rows)', () => {
    expect(parseOptionalGrantedScope(null)).toBeUndefined();
    expect(parseOptionalGrantedScope(undefined)).toBeUndefined();
  });

  it('parses a present value like parseGrantedScope', () => {
    expect(parseOptionalGrantedScope('read-write')).toBe('read-write');
    expect(parseOptionalGrantedScope('read-only')).toBe('read-only');
    expect(parseOptionalGrantedScope('admin')).toBe('read-only');
    expect(parseOptionalGrantedScope('')).toBe('read-only');
  });
});
