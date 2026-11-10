/**
 * TOKEN_PEPPER (#52): optional, validated at load time, never echoed, and
 * redacted from operator logs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadTokenConfig } from '../../../src/config/http/tokens.js';
import { loadHttpConfig } from '../../../src/config/environment.js';
import { redactSecretEnvValues } from '../../../src/utils/sanitize.js';

describe('loadTokenConfig', () => {
  it('is undefined when TOKEN_PEPPER is unset or empty (the ENCRYPTION_KEY fallback applies)', () => {
    expect(loadTokenConfig({})).toEqual({ tokenPepper: undefined });
    expect(loadTokenConfig({ TOKEN_PEPPER: '' })).toEqual({ tokenPepper: undefined });
  });

  it('accepts 32 bytes as base64 or 64 hex characters, trimmed', () => {
    const bytes = randomBytes(32);
    expect(loadTokenConfig({ TOKEN_PEPPER: bytes.toString('base64') }).tokenPepper).toBe(bytes.toString('base64'));
    expect(loadTokenConfig({ TOKEN_PEPPER: ` ${bytes.toString('hex')} ` }).tokenPepper).toBe(bytes.toString('hex'));
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['63 hex characters', randomBytes(32).toString('hex').slice(1)],
    ['blank', '   '],
  ])('refuses a pepper that is %s, without echoing it', (_name, value) => {
    let message = '';
    try {
      loadTokenConfig({ TOKEN_PEPPER: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/TOKEN_PEPPER/);
    if (value.trim() !== '') expect(message).not.toContain(value.trim());
  });
});

describe('loadHttpConfig and TOKEN_PEPPER', () => {
  const saved = process.env['TOKEN_PEPPER'];
  afterEach(() => {
    if (saved === undefined) delete process.env['TOKEN_PEPPER'];
    else process.env['TOKEN_PEPPER'] = saved;
  });

  it('carries the validated pepper, and stops startup on a bad one', () => {
    const value = randomBytes(32).toString('base64');
    process.env['TOKEN_PEPPER'] = value;
    expect(loadHttpConfig().tokenPepper).toBe(value);
    process.env['TOKEN_PEPPER'] = 'nope';
    expect(() => loadHttpConfig()).toThrow(/TOKEN_PEPPER/);
    delete process.env['TOKEN_PEPPER'];
    expect(loadHttpConfig().tokenPepper).toBeUndefined();
  });
});

describe('operator logs', () => {
  it('redacts the TOKEN_PEPPER value', () => {
    const value = randomBytes(32).toString('base64');
    expect(redactSecretEnvValues(`boom ${value}`, { TOKEN_PEPPER: value })).toBe('boom [TOKEN_PEPPER REDACTED]');
  });
});
