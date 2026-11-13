/**
 * Gate G8 at the provider (#52): what reaches storage, and what is at rest.
 *
 * A storage spy counts every call. A random `ymcp1_` value, an unprefixed
 * value that isn't 43 base64url characters, and every stored key presented
 * verbatim are refused with zero storage calls, at /mcp (verifyAccessToken),
 * at /token (refresh and code), at /oauth/ynab/start (state) and at /revoke
 * (which deletes nothing). And a full flow on memory storage leaves no value a
 * client holds anywhere in storage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>(
    '../../../src/auth/ynab-oauth.js'
  );
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
  };
});

import { MemoryStorage } from '../../../src/storage/memory.js';
import type { Storage } from '../../../src/storage/types.js';
import { Encryptor } from '../../../src/crypto.js';
import { McpOAuthProvider } from '../../../src/auth/mcp-provider.js';
import { TEST_TOKEN_HASHER, testKey } from '../helpers/token-hasher.js';

/** `storage` with every method call counted. */
function spied(storage: Storage): { storage: Storage; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { storage: proxy, calls };
}

function makeProvider(storage: Storage): McpOAuthProvider {
  return new McpOAuthProvider({
    storage,
    encryptor: new Encryptor(randomBytes(32).toString('base64')),
    tokenHasher: TEST_TOKEN_HASHER,
    ynab: { clientId: 'cid', clientSecret: 'sec' },
    publicUrl: 'https://mcp.example.com',
    allowWrite: true,
    globalReadOnly: false,
    accessTokenTtlSec: 3600,
    authCodeTtlSec: 600,
  });
}

/** Consent, start and callback: the state, its cookie nonce and the code. */
async function drive(
  provider: McpOAuthProvider,
  client: OAuthClientInformationFull
): Promise<{ state: string; code: string }> {
  const res = { setHeader: vi.fn(), append: vi.fn(), send: vi.fn() };
  await provider.authorize(
    client,
    { redirectUri: 'https://client/cb', codeChallenge: 'chal', state: 'cs', scopes: ['ynab'] },
    res as unknown as Response
  );
  const html = res.send.mock.calls[0]?.[0] as string;
  const state = decodeURIComponent(/state=([^&"]+)&amp;scope=read-only/.exec(html)?.[1] ?? '');
  const cookie = (res.append.mock.calls.find((c) => c[0] === 'Set-Cookie')?.[1] as string).split(';')[0] ?? '';
  const nonce = cookie.slice(cookie.indexOf('=') + 1);
  await provider.startYnabAuthorization(state, 'read-write', nonce);
  const code = new URL(await provider.handleYnabCallback('ynabcode', state, nonce)).searchParams.get('code') ?? '';
  return { state, code };
}

const forgedIssued = (): string =>
  `ymcp1_${randomBytes(32).toString('base64url')}_${randomBytes(16).toString('base64url')}`;

let base: MemoryStorage;
let provider: McpOAuthProvider;
let client: OAuthClientInformationFull;
let calls: string[];

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  base = new MemoryStorage();
  await base.init();
  const s = spied(base);
  calls = s.calls;
  provider = makeProvider(s.storage);
  client = await provider.clientsStore.registerClient({ redirect_uris: ['https://client/cb'], client_name: 'c' });
});

describe('G8: refused before storage', () => {
  const refusedValues: Array<[string, () => string]> = [
    ['a random ymcp1_ value', forgedIssued],
    ['an unprefixed value that is not 43 characters', () => randomBytes(24).toString('base64url')],
    ['a stored h1. key', () => testKey('access', randomBytes(32).toString('base64url'))],
  ];

  it.each(refusedValues)('%s: zero storage calls at every entry point', async (_name, make) => {
    const value = make();
    calls.length = 0;
    await expect(provider.verifyAccessToken(value)).rejects.toThrow('Invalid or expired access token');
    await expect(provider.exchangeRefreshToken(client, value)).rejects.toThrow('Invalid refresh token');
    await expect(provider.challengeForAuthorizationCode(client, value)).rejects.toThrow(
      'Invalid or expired authorization code'
    );
    await expect(provider.exchangeAuthorizationCode(client, value)).rejects.toThrow(
      'Invalid or expired authorization code'
    );
    await expect(provider.startYnabAuthorization(value, 'read-only', 'nonce')).rejects.toThrow();
    await expect(provider.handleYnabCallback('c', value, 'nonce')).rejects.toThrow();
    await expect(provider.denyAuthorization(value, 'access_denied', 'nonce')).rejects.toThrow();
    await expect(provider.revokeToken(client, { token: value })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('every stored key presented verbatim is refused, and /revoke deletes nothing', async () => {
    const { code } = await drive(provider, client);
    // A second consent leaves a pending state behind.
    const res = { setHeader: vi.fn(), append: vi.fn(), send: vi.fn() };
    await provider.authorize(
      client,
      { redirectUri: 'https://client/cb', codeChallenge: 'chal', state: 'cs', scopes: [] },
      res as unknown as Response
    );
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    const access = Reflect.get(base, 'accessTokens') as Map<string, unknown>;
    const refresh = Reflect.get(base, 'refreshTokens') as Map<string, unknown>;
    const pending = Reflect.get(base, 'pending') as Map<string, unknown> | undefined;
    const storedKeys = [...access.keys(), ...refresh.keys(), ...(pending?.keys() ?? [])];
    expect(storedKeys.length).toBeGreaterThanOrEqual(2);
    const before = { access: access.size, refresh: refresh.size };

    calls.length = 0;
    for (const key of storedKeys) {
      await expect(provider.verifyAccessToken(key)).rejects.toThrow();
      await expect(provider.exchangeRefreshToken(client, key)).rejects.toThrow();
      await expect(provider.challengeForAuthorizationCode(client, key)).rejects.toThrow();
      await expect(provider.startYnabAuthorization(key, 'read-only', 'nonce')).rejects.toThrow();
      await provider.revokeToken(client, { token: key });
    }
    expect(calls).toEqual([]);
    expect({ access: access.size, refresh: refresh.size }).toEqual(before);
    // The values themselves still work.
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeDefined();
  });

  it('a value of another kind is refused before storage (an access token at the refresh grant)', async () => {
    const { code } = await drive(provider, client);
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    calls.length = 0;
    await expect(provider.exchangeRefreshToken(client, tokens.access_token)).rejects.toThrow('Invalid refresh token');
    await expect(provider.verifyAccessToken(tokens.refresh_token as string)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('G8: at rest on memory storage', () => {
  it('a full flow, a refresh and a registration leave no client-held value in storage', async () => {
    const confidential = await provider.clientsStore.registerClient({
      redirect_uris: ['https://client/cb'],
      client_name: 'conf',
      client_secret: randomBytes(32).toString('hex'),
      client_secret_expires_at: 0,
    } as OAuthClientInformationFull);
    const { state, code } = await drive(provider, client);
    await provider.challengeForAuthorizationCode(client, code);
    const tokens: OAuthTokens = await provider.exchangeAuthorizationCode(client, code);
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token as string);

    const everything = JSON.stringify(
      Object.fromEntries(
        Object.entries(base as unknown as Record<string, unknown>)
          .filter(([, v]) => v instanceof Map)
          .map(([k, v]) => [k, [...(v as Map<unknown, unknown>).entries()]])
      )
    );
    for (const value of [
      state,
      code,
      tokens.access_token,
      tokens.refresh_token,
      rotated.access_token,
      rotated.refresh_token,
      confidential.client_secret,
    ]) {
      expect(value).toBeTruthy();
      expect(everything).not.toContain(value as string);
    }
    expect(everything).toContain('client_secret_hash');
    // Every stored token key is an h1. key.
    for (const name of ['accessTokens', 'refreshTokens', 'consumedRefreshTokens', 'consumedAuthCodes']) {
      const map = Reflect.get(base, name) as Map<string, unknown> | undefined;
      expect(map, name).toBeDefined();
      for (const key of map!.keys()) expect(key).toMatch(/^h1\.[0-9a-f]{64}$/);
    }
    // The SDK sees the hash as client_secret, never the secret.
    const seen = await provider.clientsStore.getClient(confidential.client_id);
    expect(seen?.client_secret).toMatch(/^s256\.[0-9a-f]{64}$/);
  });
});
