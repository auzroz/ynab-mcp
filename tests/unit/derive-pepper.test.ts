/**
 * `ynab-mcp derive-pepper` (#57b, D-6(c)): prints the pepper a server without
 * TOKEN_PEPPER derives from ENCRYPTION_KEY, so pinning it as TOKEN_PEPPER
 * keeps every stored token hash valid through a key rotation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { derivePepper, runEntry } from '../../src/entry.js';
import { TokenHasher } from '../../src/auth/token-hash.js';

function run(env: Record<string, string | undefined>): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = derivePepper({ env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('derive-pepper', () => {
  it('prints the pepper the server derives from ENCRYPTION_KEY, as 64 hex characters', () => {
    const key = randomBytes(32).toString('base64');
    const { code, out, err } = run({ ENCRYPTION_KEY: key });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^[0-9a-f]{64}$/);
    // Pinned as TOKEN_PEPPER, it is the same pepper: the stored fingerprint still matches.
    expect(TokenHasher.fromSecrets({ tokenPepper: out[0] }).fingerprint).toBe(
      TokenHasher.fromSecrets({ encryptionKey: key }).fingerprint
    );
    // And it then no longer depends on ENCRYPTION_KEY.
    expect(
      TokenHasher.fromSecrets({ tokenPepper: out[0], encryptionKey: randomBytes(32).toString('base64') }).fingerprint
    ).toBe(TokenHasher.fromSecrets({ encryptionKey: key }).fingerprint);
    expect(err.join('\n')).toMatch(/Set TOKEN_PEPPER/);
    expect(err.join('\n')).not.toContain(key);
    expect(err.join('\n')).not.toContain(out[0]);
  });

  it('prints nothing when TOKEN_PEPPER is already set', () => {
    const { code, out, err } = run({ ENCRYPTION_KEY: randomBytes(32).toString('base64'), TOKEN_PEPPER: randomBytes(32).toString('hex') });
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/already set/);
  });

  it('fails, naming only the variable, without a usable ENCRYPTION_KEY', () => {
    expect(run({})).toMatchObject({ code: 1, out: [] });
    const bad = 'not-a-32-byte-key-at-all';
    const { code, out, err } = run({ ENCRYPTION_KEY: bad });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/ENCRYPTION_KEY must decode to 32 bytes/);
    expect(err.join('\n')).not.toContain(bad);
  });

  it('runs from the command line instead of the server, reading the key from the environment', () => {
    const key = randomBytes(32).toString('base64');
    vi.stubEnv('ENCRYPTION_KEY', key);
    vi.stubEnv('TOKEN_PEPPER', '');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runEntry(['node', 'dist/index.js', 'derive-pepper']);
    expect(process.exitCode).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^[0-9a-f]{64}\n$/);
    vi.unstubAllEnvs();
  });
});
