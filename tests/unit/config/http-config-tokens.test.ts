/**
 * TOKEN_PEPPER (#52): optional, validated at load time, never echoed, and
 * redacted from operator logs.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { parseTokenPepper } from '../../../src/config/http/tokens.js';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { redactSecretEnvValues } from '../../../src/utils/sanitize.js';

describe('parseTokenPepper', () => {
  it('is undefined when TOKEN_PEPPER is unset or empty (the ENCRYPTION_KEY fallback applies)', () => {
    expect(parseTokenPepper(undefined)).toBeUndefined();
    expect(parseTokenPepper('')).toBeUndefined();
  });

  it('accepts 32 bytes as base64 or 64 hex characters, trimmed', () => {
    const bytes = randomBytes(32);
    expect(parseTokenPepper(bytes.toString('base64'))).toBe(bytes.toString('base64'));
    expect(parseTokenPepper(` ${bytes.toString('hex')} `)).toBe(bytes.toString('hex'));
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['63 hex characters', randomBytes(32).toString('hex').slice(1)],
    ['blank', '   '],
  ])('refuses a pepper that is %s, without echoing it', (_name, value) => {
    let message = '';
    try {
      parseTokenPepper(value);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/TOKEN_PEPPER/);
    if (value.trim() !== '') expect(message).not.toContain(value.trim());
  });
});

describe('loadHttpConfig and TOKEN_PEPPER', () => {
  const header = { AUTH_MODE: 'header' };
  it('carries the validated pepper, and lists a bad one as a config problem', () => {
    const value = randomBytes(32).toString('base64');
    expect(loadHttpConfig({ ...header, TOKEN_PEPPER: value }).tokenPepper).toBe(value);
    let message = '';
    try {
      loadHttpConfig({ ...header, TOKEN_PEPPER: 'nope' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/TOKEN_PEPPER/);
    expect(message).not.toContain('nope');
    expect(loadHttpConfig(header).tokenPepper).toBeUndefined();
  });
});

describe('operator logs', () => {
  it('redacts the TOKEN_PEPPER value', () => {
    const value = randomBytes(32).toString('base64');
    expect(redactSecretEnvValues(`boom ${value}`, { TOKEN_PEPPER: value })).toBe('boom [TOKEN_PEPPER REDACTED]');
  });
});
