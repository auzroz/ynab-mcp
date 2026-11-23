/**
 * Gate G8 over oidc-provider (#52, ADR-0002 D4): what reaches storage, and
 * what is at rest, through the library's own endpoints and the interaction.
 *
 * A storage spy records every call. A random `ymcp1_` value, an unprefixed
 * value that isn't 43 base64url characters, and every stored `h1.` key
 * presented verbatim are refused without any storage read keyed by them, at
 * /mcp (the verifier), at /token (refresh and code), at the YNAB callback and
 * complete legs (state) and at /revoke (which deletes nothing). A value of
 * another kind is refused (the kind is part of its HMAC). And a full flow, a
 * refresh and a confidential registration on memory storage leave no value a
 * client or browser holds anywhere in storage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>('../../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
  };
});

import { MemoryStorage } from '../../../src/storage/memory.js';
import type { Storage } from '../../../src/storage/types.js';
import { TEST_TOKEN_HASHER, testKey } from '../helpers/token-hasher.js';
import { expectInvalidToken } from '../helpers/invalid-token.js';
import { exchangeCode as ynabExchangeCode } from '../../../src/auth/ynab-oauth.js';
import {
  CookieJar,
  authorizeUrl,
  browse,
  interactionUid,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  pkcePair,
  refresh,
  registerClient,
  type OidcTestApp,
} from '../helpers/oidc-app.js';

/** `storage` with every method call recorded, with its arguments. */
function spied(storage: Storage): { storage: Storage; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const proxy = new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { storage: proxy, calls };
}

const forgedIssued = (): string => `ymcp1_${randomBytes(32).toString('base64url')}_${randomBytes(16).toString('base64url')}`;

let base: MemoryStorage;
let calls: Array<{ method: string; args: unknown[] }>;
let t: OidcTestApp;
let clientId: string;

/**
 * A live interaction in its own browser, waiting for YNAB: its uid, the
 * browser's cookies, and its own storage key. `complete` reads that row by
 * the browser's cookie, legitimately, before it compares the state.
 */
interface LiveInteraction {
  uid: string;
  jar: CookieJar;
  key: string;
}

let live: LiveInteraction;

const testLibraryKey = (kind: 'interaction', id: string): string => TEST_TOKEN_HASHER.libraryStorageKey(kind, id) as string;

async function startInteraction(): Promise<LiveInteraction> {
  const jar = new CookieJar();
  const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkcePair().challenge }));
  const uid = interactionUid(auth.headers['location'] as string);
  expect((await browse(t.app, jar, auth.headers['location'] as string)).status).toBe(200);
  expect((await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-only`)).status).toBe(302);
  return { uid, jar, key: testLibraryKey('interaction', uid) };
}

/** The calls that read or wrote a row keyed by a credential (an `h1.` key), or revoked a grant; the live interaction's own row aside. */
const credentialCalls = (): string[] =>
  calls
    .filter(
      (c) =>
        c.method === 'revokeOAuthGrant' ||
        c.args.some((a) => typeof a === 'string' && a.startsWith('h1.') && a !== live.key)
    )
    .map((c) => c.method);

/** Present `value` at every entry point a client or browser reaches. */
async function presentEverywhere(value: string): Promise<void> {
  await expectInvalidToken(t.verifier.verifyAccessToken(value));
  const viaRefresh = await refresh(t.app, { clientId, refreshToken: value });
  expect(viaRefresh.body.error).toBe('invalid_grant');
  const viaCode = await exchangeCode(t.app, { clientId, code: value, verifier: pkcePair().verifier });
  expect(viaCode.body.error).toBe('invalid_grant');
  const revoked = await request(t.app).post('/revoke').type('form').send({ token: value, client_id: clientId });
  expect(revoked.status).toBe(200);
  // The callback only routes (it checks no secret): it sends the browser to the interaction's complete.
  const state = `${live.uid}.${value}`;
  const callback = await browse(t.app, live.jar, `/oauth/ynab/callback?state=${encodeURIComponent(state)}&code=c`);
  expect([302, 400]).toContain(callback.status);
  // complete with the live interaction's own cookie: past the browser check, so the 400 is the state comparison.
  vi.mocked(ynabExchangeCode).mockClear();
  const complete = await browse(t.app, live.jar, `/oauth/interaction/${live.uid}/complete?state=${encodeURIComponent(state)}&code=c`);
  expect(complete.status).toBe(400);
  expect(ynabExchangeCode).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  base = new MemoryStorage();
  await base.init();
  const s = spied(base);
  calls = s.calls;
  t = buildOidcTestApp(base, { providerStore: s.storage, interactionStore: s.storage });
  ({ clientId } = await registerClient(t.app));
  live = await startInteraction();
});

it('the live interaction completes with its own state, so the refusals below come from the comparison', async () => {
  const start = await browse(t.app, live.jar, `/oauth/interaction/${live.uid}/start?scope=read-only`);
  const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;
  const complete = await browse(t.app, live.jar, `/oauth/interaction/${live.uid}/complete?state=${encodeURIComponent(state)}&code=c`);
  expect(complete.status).toBe(303);
});

describe('G8: refused before storage', () => {
  const refusedValues: Array<[string, () => string]> = [
    ['a random ymcp1_ value', forgedIssued],
    ['an unprefixed value that is not 43 characters', () => randomBytes(24).toString('base64url')],
    ['a stored h1. key', () => testKey('access', randomBytes(32).toString('base64url'))],
  ];

  it.each(refusedValues)('%s: no credential read at any entry point', async (_name, make) => {
    const value = make();
    calls.length = 0;
    await presentEverywhere(value);
    expect(credentialCalls()).toEqual([]);
  });

  it('every stored key presented verbatim is refused, and /revoke deletes nothing', async () => {
    const pkce = pkcePair();
    const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge });
    const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
    // A second authorization left pending (an interaction row).
    await browse(t.app, new CookieJar(), `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${pkce.challenge}&code_challenge_method=S256`);
    const rows = Reflect.get(base, 'oauthRows') as Map<string, unknown>;
    const storedKeys = [...rows.keys()].filter((k) => k.startsWith('h1.'));
    expect(storedKeys.length).toBeGreaterThanOrEqual(4);
    const before = rows.size;

    calls.length = 0;
    for (const key of storedKeys) await presentEverywhere(key);
    expect(credentialCalls()).toEqual([]);
    expect(rows.size).toBe(before);
    // The values themselves still work.
    await expect(t.verifier.verifyAccessToken(tokens.body.access_token as string)).resolves.toBeDefined();
  });

  it('a value of another kind is refused: an access token at the refresh grant, a refresh token at /mcp', async () => {
    const pkce = pkcePair();
    const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge });
    const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
    const access = tokens.body.access_token as string;
    const refreshToken = tokens.body.refresh_token as string;
    expect((await refresh(t.app, { clientId, refreshToken: access })).body.error).toBe('invalid_grant');
    await expectInvalidToken(t.verifier.verifyAccessToken(refreshToken));
    // Neither refusal touched the grant.
    await expect(t.verifier.verifyAccessToken(access)).resolves.toBeDefined();
    expect((await refresh(t.app, { clientId, refreshToken })).status).toBe(200);
  });
});

describe('G8: at rest on memory storage', () => {
  it('a full flow, a refresh and a registration leave no client- or browser-held value in storage', async () => {
    const confidential = await registerClient(t.app, { token_endpoint_auth_method: 'client_secret_post', client_name: 'conf' });
    expect(confidential.clientSecret).toBeTruthy();
    const jar = new CookieJar();
    const pkce = pkcePair();
    const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge });
    const code = flow.params.get('code') as string;
    const tokens = await exchangeCode(t.app, { clientId, code, verifier: pkce.verifier });
    const rotated = await refresh(t.app, { clientId, refreshToken: tokens.body.refresh_token as string });
    expect(rotated.status).toBe(200);
    // The YNAB state's secret half (the part after the interaction uid).
    const ynabState = (flow.ynabUrl.searchParams.get('state') as string).split('.')[1];

    const everything = JSON.stringify(
      Object.fromEntries(
        Object.entries(base as unknown as Record<string, unknown>)
          .filter(([, v]) => v instanceof Map)
          .map(([k, v]) => [k, [...(v as Map<unknown, unknown>).entries()]])
      )
    );
    const held = [
      code,
      ynabState,
      tokens.body.access_token,
      tokens.body.refresh_token,
      rotated.body.access_token,
      rotated.body.refresh_token,
      confidential.clientSecret,
      jar.value('_session'),
    ];
    for (const value of held) {
      expect(value).toBeTruthy();
      expect(everything).not.toContain(value as string);
    }
    expect(everything).toContain('client_secret_hash');
    // Every row keyed by a credential is keyed by its h1. HMAC; the others by a plain id.
    const rows = Reflect.get(base, 'oauthRows') as Map<string, { model: string }>;
    for (const [key, row] of rows) {
      if (['Grant', 'Client', 'SignIn'].includes(row.model)) expect(key).toMatch(new RegExp(`^${row.model}:`));
      else expect(key, row.model).toMatch(/^h1\.[0-9a-f]{64}$/);
    }
    // The library sees the hash as client_secret, never the secret.
    const seen = await t.oidc.provider.Client.find(confidential.clientId);
    expect(seen?.clientSecret).toMatch(/^s256\.[0-9a-f]{64}$/);
  });
});
