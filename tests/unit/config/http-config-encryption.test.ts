/**
 * ENCRYPTION_KEY_ID and ENCRYPTION_KEY_PREVIOUS (#57b): validated at load
 * time, never echoed, and a rotation refused without TOKEN_PEPPER.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadHttpConfig } from '../../../src/config/environment.js';

const key = (): string => randomBytes(32).toString('base64');
const OAUTH = {
  AUTH_MODE: 'oauth',
  PUBLIC_URL: 'https://mcp.example.com',
  YNAB_OAUTH_CLIENT_ID: 'cid',
  YNAB_OAUTH_CLIENT_SECRET: 'csecret-value',
};

function failure(env: Record<string, string>): string {
  try {
    loadHttpConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadHttpConfig to throw');
}

describe('ENCRYPTION_KEY_ID and ENCRYPTION_KEY_PREVIOUS', () => {
  it('are optional', () => {
    const c = loadHttpConfig({ ...OAUTH, ENCRYPTION_KEY: key() });
    expect(c.encryptionKeyId).toBeUndefined();
    expect(c.encryptionKeyPrevious).toBeUndefined();
  });

  it('accept a rotation with TOKEN_PEPPER set', () => {
    const previous = `1:${key()}`;
    const c = loadHttpConfig({
      ...OAUTH,
      ENCRYPTION_KEY: key(),
      ENCRYPTION_KEY_ID: '2',
      ENCRYPTION_KEY_PREVIOUS: previous,
      TOKEN_PEPPER: randomBytes(32).toString('hex'),
    });
    expect(c.encryptionKeyId).toBe('2');
    expect(c.encryptionKeyPrevious).toBe(previous);
  });

  it('refuses a rotation without TOKEN_PEPPER, pointing at derive-pepper', () => {
    const msg = failure({ ...OAUTH, ENCRYPTION_KEY: key(), ENCRYPTION_KEY_ID: '2', ENCRYPTION_KEY_PREVIOUS: `1:${key()}` });
    expect(msg).toMatch(/ENCRYPTION_KEY_PREVIOUS requires TOKEN_PEPPER: run `ynab-mcp derive-pepper`/);
  });

  it.each([
    ['a non-numeric id', { ENCRYPTION_KEY_ID: 'two' }, /ENCRYPTION_KEY_ID must be a key id/],
    ['id zero', { ENCRYPTION_KEY_ID: '0' }, /ENCRYPTION_KEY_ID must be a key id/],
    ['a malformed list', { ENCRYPTION_KEY_PREVIOUS: 'just-a-key-without-an-id' }, /entry 1 must be <id>:<key>/],
  ])('refuses %s without echoing it', (_name, extra, pattern) => {
    const env: Record<string, string> = { ...OAUTH, ENCRYPTION_KEY: key(), ...extra };
    const msg = failure(env);
    expect(msg).toMatch(pattern);
    for (const value of Object.values(extra)) expect(msg).not.toContain(value);
  });

  it('refuses the current id among the previous keys, and one key under two ids', () => {
    const current = key();
    const pepper = randomBytes(32).toString('hex');
    const sameId = failure({ ...OAUTH, ENCRYPTION_KEY: current, ENCRYPTION_KEY_PREVIOUS: `1:${key()}`, TOKEN_PEPPER: pepper });
    expect(sameId).toMatch(/needs an id of its own/);
    const sameKey = failure({
      ...OAUTH,
      ENCRYPTION_KEY: current,
      ENCRYPTION_KEY_ID: '2',
      ENCRYPTION_KEY_PREVIOUS: `1:${current}`,
      TOKEN_PEPPER: pepper,
    });
    expect(sameKey).toMatch(/already configured under another id/);
    for (const msg of [sameId, sameKey]) expect(msg).not.toContain(current);
  });
});
