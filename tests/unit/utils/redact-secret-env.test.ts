import { describe, it, expect } from 'vitest';
import { redactSecretEnvValues, sanitizeErrorMessage } from '../../../src/utils/sanitize.js';

describe('redactSecretEnvValues', () => {
  const env = {
    YNAB_ACCESS_TOKEN: 'tok-0123456789abcdef',
    YNAB_OAUTH_CLIENT_SECRET: 'client-secret-xyz123',
    ENCRYPTION_KEY: 'a2V5LWJ5dGVzLWJhc2U2NA==',
    DATABASE_URL: 'postgres://ynab:hunter22@db:5432/ynab',
  };

  it('removes each secret value wherever it appears, even without a prefix', () => {
    const msg = `boom ${env.YNAB_ACCESS_TOKEN} and ${env.YNAB_OAUTH_CLIENT_SECRET} / ${env.ENCRYPTION_KEY} at ${env.DATABASE_URL}`;
    const out = redactSecretEnvValues(msg, env);
    for (const v of Object.values(env)) expect(out).not.toContain(v);
    expect(out).toContain('[YNAB_ACCESS_TOKEN REDACTED]');
    expect(out).toContain('[DATABASE_URL REDACTED]');
  });

  it('keeps startup errors readable (sanitizeErrorMessage would garble them)', () => {
    const missing = 'Configuration validation failed:\n  - accessToken: YNAB_ACCESS_TOKEN is required';
    expect(redactSecretEnvValues(missing, {})).toBe(missing);
    // The pattern sanitizer is for client-facing text, not operator logs.
    expect(sanitizeErrorMessage(missing)).not.toContain('YNAB_ACCESS_TOKEN is required');

    const path = 'unable to open database file /app/data/ynab.db';
    expect(redactSecretEnvValues(path, env)).toBe(path);
  });

  it('ignores unset and very short values', () => {
    expect(redactSecretEnvValues('the key is abc', { ENCRYPTION_KEY: 'abc' })).toBe('the key is abc');
    expect(redactSecretEnvValues('nothing here', { YNAB_ACCESS_TOKEN: undefined })).toBe('nothing here');
  });
});
