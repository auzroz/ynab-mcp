import { describe, it, expect } from 'vitest';
import {
  sanitizeString,
  sanitizeStringOrEmpty,
  sanitizeMemo,
  sanitizeName,
  sanitizeErrorMessage,
  stripBidi,
  stripInvisible,
  hasInvisible,
} from '../../../src/utils/sanitize.js';

describe('sanitize utilities', () => {
  describe('stripBidi', () => {
    it.each([
      ['U+061C ARABIC LETTER MARK', '\u061C'],
      ['U+200E LRM', '\u200E'],
      ['U+200F RLM', '\u200F'],
      ['U+202A LRE', '\u202A'],
      ['U+202B RLE', '\u202B'],
      ['U+202C PDF', '\u202C'],
      ['U+202D LRO', '\u202D'],
      ['U+202E RLO', '\u202E'],
      ['U+2066 LRI', '\u2066'],
      ['U+2067 RLI', '\u2067'],
      ['U+2068 FSI', '\u2068'],
      ['U+2069 PDI', '\u2069'],
    ])('removes %s', (_name, ch) => {
      expect(stripBidi(`a${ch}b`)).toBe('ab');
    });

    it('leaves neighbouring code points untouched', () => {
      // U+202F, U+2065 and U+206A are outside the bidi set
      const input = 'x\u202Fy\u2065z\u206Aw';
      expect(stripBidi(input)).toBe(input);
    });

    it('removes mixed bidi controls in ordinary text', () => {
      expect(stripBidi('Pay\u202Ee\u2066e\u2069 \u061Cok')).toBe('Payee ok');
    });

    it('returns empty string for empty input', () => {
      expect(stripBidi('')).toBe('');
    });
  });

  describe('stripInvisible (#55: client names on the consent page)', () => {
    it.each([
      ['U+200B ZERO WIDTH SPACE', '\u200B'],
      ['U+200C ZWNJ', '\u200C'],
      ['U+200D ZWJ', '\u200D'],
      ['U+2060 WORD JOINER', '\u2060'],
      ['U+FEFF BOM', '\uFEFF'],
      ['U+00AD SOFT HYPHEN', '\u00AD'],
      ['U+202E RLO (bidi)', '\u202E'],
      ['U+E0041 TAG LATIN CAPITAL A', '\u{E0041}'],
      ['U+034F COMBINING GRAPHEME JOINER', '\u034F'],
      ['U+3164 HANGUL FILLER', '\u3164'],
    ])('removes %s', (_name, ch) => {
      expect(stripInvisible(`a${ch}b`)).toBe('ab');
      expect(hasInvisible(`a${ch}b`)).toBe(true);
    });

    it('keeps visible text, spaces and emoji', () => {
      const input = 'Claude Desktop 🙂 é';
      expect(stripInvisible(input)).toBe(input);
      expect(hasInvisible(input)).toBe(false);
    });
  });

  describe('bidi controls in sanitizeString', () => {
    it('strips every bidi control code point', () => {
      const bidi = '\u061C\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
      expect(sanitizeString(`safe${bidi}text`)).toBe('safetext');
    });

    it('strips bidi controls in mixed text and keeps visible content', () => {
      expect(sanitizeString('  Coffee\u202E eeffoC \u2069 shop  ')).toBe('Coffee eeffoC  shop');
    });

    it('strips bidi controls from memos and names', () => {
      expect(sanitizeMemo('note\u202Ehidden')).toBe('notehidden');
      expect(sanitizeName('\u2067Payee\u2069')).toBe('Payee');
    });

    it('applies length limits after stripping bidi controls', () => {
      // 15 visible chars plus 4 bidi controls; the limit of 10 counts only visible chars
      expect(sanitizeString('abc\u202Adef\u202Bghi\u202Cjkl\u202Dmno', 10)).toBe('abcdefg...');
    });
  });

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

    it('handles maxLength of exactly 3', () => {
      expect(sanitizeString('hello', 3)).toBe('hel');
    });

    it('handles maxLength of 1', () => {
      expect(sanitizeString('hello', 1)).toBe('h');
    });

    it('handles maxLength of 2', () => {
      expect(sanitizeString('hello', 2)).toBe('he');
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

  describe('sanitizeErrorMessage', () => {
    it('extracts message from Error objects', () => {
      const error = new Error('Something went wrong');
      expect(sanitizeErrorMessage(error)).toBe('Something went wrong');
    });

    it('handles string errors', () => {
      expect(sanitizeErrorMessage('A string error')).toBe('A string error');
    });

    it('returns generic message for non-string/Error values', () => {
      expect(sanitizeErrorMessage(null)).toBe('An error occurred');
      expect(sanitizeErrorMessage(undefined)).toBe('An error occurred');
      expect(sanitizeErrorMessage({})).toBe('An error occurred');
      expect(sanitizeErrorMessage(123)).toBe('An error occurred');
    });

    it('redacts Bearer tokens', () => {
      const error = 'Failed with Bearer abc123xyz456 in request';
      expect(sanitizeErrorMessage(error)).toBe('Failed with Bearer [REDACTED] in request');
    });

    it('redacts token= patterns', () => {
      const error = 'Failed with token=secret123';
      expect(sanitizeErrorMessage(error)).toBe('Failed with token=[REDACTED]');
    });

    it('redacts access_token patterns', () => {
      const error = 'access_token: "my-secret-token"';
      expect(sanitizeErrorMessage(error)).toBe('access_token=[REDACTED]');
    });

    it('redacts api_key patterns', () => {
      const error = 'api_key=supersecret123';
      expect(sanitizeErrorMessage(error)).toBe('api_key=[REDACTED]');
    });

    it('redacts Unix file paths', () => {
      const error = 'Error in /Users/john/projects/app/config.ts';
      expect(sanitizeErrorMessage(error)).toBe('Error in [PATH_REDACTED]');
    });

    it('redacts Windows file paths', () => {
      const error = 'Error in C:\\Users\\john\\Documents\\secret.txt';
      expect(sanitizeErrorMessage(error)).toBe('Error in [PATH_REDACTED]');
    });

    it('redacts stack trace file references', () => {
      // Path matching happens before file reference matching
      const error = 'Error at (/home/user/app/src/index.ts:42:10)';
      expect(sanitizeErrorMessage(error)).toContain('[PATH_REDACTED]');
      expect(sanitizeErrorMessage(error)).not.toContain('/home/user');
    });

    it('redacts full stack trace at statements', () => {
      // Use a non-matching path prefix to test the stack pattern
      const error = 'at processRequest (app/server.js:100:5)';
      expect(sanitizeErrorMessage(error)).toBe('at [STACK_REDACTED]');
    });

    it('removes control characters', () => {
      const error = new Error('Error\x00with\x1Fcontrol\x7Fchars');
      expect(sanitizeErrorMessage(error)).toBe('Errorwithcontrolchars');
    });

    it('respects maxLength parameter', () => {
      const error = new Error('a'.repeat(600));
      const result = sanitizeErrorMessage(error, 100);
      expect(result.length).toBe(100);
      expect(result).toBe('a'.repeat(97) + '...');
    });

    it('handles multiple sensitive patterns in one message', () => {
      const error = 'Request to /Users/dev/app failed with token=secret123 and api_key=abc';
      const result = sanitizeErrorMessage(error);
      expect(result).not.toContain('/Users/dev/app');
      expect(result).not.toContain('secret123');
      expect(result).not.toContain('abc');
      expect(result).toContain('[PATH_REDACTED]');
      expect(result).toContain('token=[REDACTED]');
      expect(result).toContain('api_key=[REDACTED]');
    });

    it('handles Error with empty message', () => {
      const error = new Error('');
      expect(sanitizeErrorMessage(error)).toBe('');
    });

    it('redacts password patterns', () => {
      const error = 'Failed with password=secret123';
      expect(sanitizeErrorMessage(error)).toBe('Failed with password=[REDACTED]');
    });

    it('redacts pwd patterns', () => {
      const error = 'Failed with pwd: "mypassword"';
      expect(sanitizeErrorMessage(error)).toBe('Failed with pwd=[REDACTED]');
    });

    it('redacts secret patterns', () => {
      const error = 'secret=supersecret123 was exposed';
      expect(sanitizeErrorMessage(error)).toBe('secret=[REDACTED] was exposed');
    });
  });
});
