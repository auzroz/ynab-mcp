/**
 * The OAuth calls are capped at the configured request ceiling (#58): with
 * MCP_REQUEST_TIMEOUT_MS at 5000, a stalled YNAB refresh aborts at 5 s, not 10 s,
 * so it cannot hold an in-flight slot past the ceiling. The refresh stays shared
 * across a user's concurrent requests (one call to YNAB), so it is bounded by the
 * setting, not by any one request's deadline. fetch is a stub; the abort timer is
 * shortened to 20 ms after asserting the value it was asked for.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { Encryptor } from '../../../src/crypto.js';
import { YnabTokenResolver } from '../../../src/auth/user-session.js';
import { getYnabUserId } from '../../../src/auth/ynab-oauth.js';
import { OUTBOUND_TIMEOUT_MS } from '../../../src/services/outbound.js';

const fetchMock = vi.fn<typeof fetch>();

function stalled(): void {
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
  );
}

async function setup(timeoutMs: number | undefined) {
  const storage = new MemoryStorage();
  const encryptor = new Encryptor(randomBytes(32).toString('base64'));
  await storage.upsertUser({
    userId: 'u1',
    grantedScope: 'read-only',
    encryptedRefreshToken: encryptor.encrypt('rt0'),
    updatedAt: Date.now(),
  });
  const resolver = new YnabTokenResolver(storage, encryptor, {
    clientId: 'cid',
    clientSecret: 'sec',
    endpoints: { tokenUrl: 'https://mock.ynab.test/oauth/token', apiBaseUrl: 'https://mock.ynab.test/v1' },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return resolver;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(20));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OAuth timeout capped at the request ceiling', () => {
  it('a stalled refresh is asked to abort at 5 s when the ceiling is 5000 ms', async () => {
    stalled();
    const resolver = await setup(5000);
    await expect(resolver.resolve('u1')).rejects.toThrow();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
  });

  it('keeps the shared refresh: concurrent resolves make one call to YNAB and share its failure', async () => {
    stalled();
    const resolver = await setup(5000);
    const results = await Promise.allSettled([resolver.resolve('u1'), resolver.resolve('u1'), resolver.resolve('u1')]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults to 10 s when no ceiling is configured (stdio)', async () => {
    stalled();
    const resolver = await setup(undefined);
    await expect(resolver.resolve('u1')).rejects.toThrow();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(OUTBOUND_TIMEOUT_MS);
  });

  it('applies to the user lookup too', async () => {
    stalled();
    await expect(getYnabUserId('tok', { apiBaseUrl: 'https://mock.ynab.test/v1' }, 5000)).rejects.toThrow();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
  });
});
