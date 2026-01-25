import { describe, it, expect } from 'vitest';
import {
  sanitizeString,
  sanitizeStringOrEmpty,
  sanitizeMemo,
  sanitizeName,
} from '../../../src/utils/sanitize.js';

describe('sanitize utilities', () => {
  describe('sanitizeString', () => {
    it('returns null for null input', () => {
      expect(sanitizeString(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(sanitizeString(undefined)).toBeNull();
    });

    it('trims whitespace', () => {
      expect(sanitizeString('  hello world  ')).toBe('hello world');
    });

    it('removes control characters', () => {
      expect(sanitizeString('hello\x00world')).toBe('helloworld');
      expect(sanitizeString('test\x1Fvalue')).toBe('testvalue');
      expect(sanitizeString('foo\x7Fbar')).toBe('foobar');
    });

    it('removes Unicode line and paragraph separators', () => {
      // U+2028 (line separator) and U+2029 (paragraph separator) can break JS string literals
      expect(sanitizeString('hello\u2028world')).toBe('helloworld');
      expect(sanitizeString('test\u2029value')).toBe('testvalue');
      expect(sanitizeString('foo\u2028bar\u2029baz')).toBe('foobarbaz');
    });

    it('preserves tabs, newlines, and carriage returns', () => {
      expect(sanitizeString('hello\tworld')).toBe('hello\tworld');
      expect(sanitizeString('hello\nworld')).toBe('hello\nworld');
      expect(sanitizeString('hello\rworld')).toBe('hello\rworld');
    });

    it('truncates long strings within maxLength', () => {
      const longString = 'a'.repeat(600);
      const result = sanitizeString(longString);
      // Total output is exactly 500 chars (497 + 3 for '...')
      expect(result).toBe('a'.repeat(497) + '...');
      expect(result.length).toBe(500);
    });

    it('respects custom maxLength including ellipsis', () => {
      const result = sanitizeString('hello world', 5);
      // Total output is exactly 5 chars (2 + 3 for '...')
      expect(result).toBe('he...');
      expect(result.length).toBe(5);
    });

    it('handles normal strings', () => {
      expect(sanitizeString('Hello World')).toBe('Hello World');
      expect(sanitizeString('Test 123')).toBe('Test 123');
    });

    it('handles empty string', () => {
      expect(sanitizeString('')).toBe('');
    });

    it('handles control characters near truncation boundary', () => {
      // String with control chars that after removal is at the boundary
      const str = 'a'.repeat(495) + '\x00\x01\x02\x03\x04';
      const result = sanitizeString(str);
      // Control chars removed, result should be exactly 495 chars (under limit)
      expect(result).toBe('a'.repeat(495));
      expect(result?.length).toBe(495);
      expect(result).not.toContain('\x00');
    });

    it('handles control characters with truncation needed after removal', () => {
      // String that exceeds limit even after control char removal
      const str = 'a'.repeat(600) + '\x00\x01\x02';
      const result = sanitizeString(str);
      // Control chars removed, then truncated to 500 (497 + '...')
      expect(result).toBe('a'.repeat(497) + '...');
      expect(result?.length).toBe(500);
    });
  });

  describe('sanitizeStringOrEmpty', () => {
    it('returns empty string for null input', () => {
      expect(sanitizeStringOrEmpty(null)).toBe('');
    });

    it('returns empty string for undefined input', () => {
      expect(sanitizeStringOrEmpty(undefined)).toBe('');
    });

    it('returns sanitized string for valid input', () => {
      expect(sanitizeStringOrEmpty('  hello  ')).toBe('hello');
    });
  });

  describe('sanitizeMemo', () => {
    it('allows up to 1000 characters', () => {
      const longMemo = 'a'.repeat(900);
      expect(sanitizeMemo(longMemo)).toBe(longMemo);
    });

    it('truncates beyond 1000 characters within limit', () => {
      const veryLongMemo = 'a'.repeat(1100);
      const result = sanitizeMemo(veryLongMemo);
      // Total output is exactly 1000 chars (997 + 3 for '...')
      expect(result).toBe('a'.repeat(997) + '...');
      expect(result?.length).toBe(1000);
    });

    it('returns null for null input', () => {
      expect(sanitizeMemo(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(sanitizeMemo(undefined)).toBeNull();
    });
  });

  describe('sanitizeName', () => {
    it('returns "Unknown" for null input', () => {
      expect(sanitizeName(null)).toBe('Unknown');
    });

    it('returns "Unknown" for undefined input', () => {
      expect(sanitizeName(undefined)).toBe('Unknown');
    });

    it('sanitizes valid names', () => {
      expect(sanitizeName('Groceries')).toBe('Groceries');
      expect(sanitizeName('  Rent  ')).toBe('Rent');
    });

    it('removes control characters from names', () => {
      expect(sanitizeName('Test\x00Name')).toBe('TestName');
    });

    it('truncates long names within 200 characters', () => {
      const longName = 'a'.repeat(250);
      const result = sanitizeName(longName);
      // Total output is exactly 200 chars (197 + 3 for '...')
      expect(result).toBe('a'.repeat(197) + '...');
      expect(result.length).toBe(200);
    });

    it('returns "Unknown" for whitespace-only input', () => {
      expect(sanitizeName('   ')).toBe('Unknown');
      expect(sanitizeName('\t\n\r')).toBe('Unknown');
    });

    it('returns "Unknown" for control-characters-only input', () => {
      expect(sanitizeName('\x00\x01\x02')).toBe('Unknown');
      expect(sanitizeName('\x1F\x7F')).toBe('Unknown');
    });

    it('returns "Unknown" for empty string input', () => {
      expect(sanitizeName('')).toBe('Unknown');
    });
  });
});
