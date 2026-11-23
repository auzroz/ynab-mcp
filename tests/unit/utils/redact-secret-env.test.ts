import { describe, it, expect } from 'vitest';
import { redactSecretEnvValues, sanitizeErrorMessage } from '../../../src/utils/sanitize.js';

describe('redactSecretEnvValues', () => {
  // Obviously fake, low-entropy stand-ins, built at runtime so secret scanners
  // don't mistake them for real credentials.
  const fake = (label: string) => `FAKE_${label}_${'x'.repeat(12)}`;
  const env = {
    YNAB_ACCESS_TOKEN: fake('TOKEN'),
    YNAB_OAUTH_CLIENT_SECRET: fake('CLIENT'),
    ENCRYPTION_KEY: fake('KEY'),
    DATABASE_URL: `postgres://ynab:${fake('PW')}@db:5432/ynab`,
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

  it('removes each key of ENCRYPTION_KEY_PREVIOUS on its own, not only the whole list (#57b)', () => {
    const k1 = fake('PREV1');
    const k2 = fake('PREV2');
    const list = { ENCRYPTION_KEY_PREVIOUS: `1:${k1},2:${k2}` };
    const out = redactSecretEnvValues(`one ${k1} two 2:${k2} all ${list.ENCRYPTION_KEY_PREVIOUS}`, list);
    for (const v of [k1, k2]) expect(out).not.toContain(v);
    expect(out).toContain('[ENCRYPTION_KEY_PREVIOUS REDACTED]');
  });

  it('ignores unset and very short values', () => {
    expect(redactSecretEnvValues('the key is abc', { ENCRYPTION_KEY: 'abc' })).toBe('the key is abc');
    expect(redactSecretEnvValues('nothing here', { YNAB_ACCESS_TOKEN: undefined })).toBe('nothing here');
  });
});
