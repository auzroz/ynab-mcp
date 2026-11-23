/**
 * The `/mcp` verifier over oidc-provider (ADR-0002 D10): WS7.3's contract.
 * A live token bound to the canonical resource gives `AuthInfo` with the YNAB
 * user, the access level and the grant; everything else, and every failure
 * while verifying, is v2's `OAuthError(InvalidToken)` with the one message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/auth/ynab-oauth.js')>(
    '../../../../src/auth/ynab-oauth.js'
  );
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ynab-access', refreshToken: 'ynab-refresh', expiresAt: Date.now() + 7_200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
  };
});

import { bearerAuthChallengeResponse } from '@modelcontextprotocol/server';
import { MemoryStorage } from '../../../../src/storage/memory.js';
import { createAccessTokenVerifier, grantedScopeOf } from '../../../../src/auth/oidc/verifier.js';
import { expectInvalidToken } from '../../helpers/invalid-token.js';
import {
  RESOURCE,
  CookieJar,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  pkcePair,
  registerClient,
  type OidcTestApp,
} from '../../helpers/oidc-app.js';

let storage: MemoryStorage;
let t: OidcTestApp;
let clientId: string;

async function issue(choice: 'read-only' | 'read-write' = 'read-write'): Promise<{ access: string; refresh: string }> {
  const pkce = pkcePair();
  const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge, choice });
  const res = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
  return { access: res.body.access_token as string, refresh: res.body.refresh_token as string };
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  storage = new MemoryStorage();
  await storage.init();
  t = buildOidcTestApp(storage);
  ({ clientId } = await registerClient(t.app));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('grantedScopeOf (D7)', () => {
  it('is read-write only when the scope includes read-write', () => {
    expect(grantedScopeOf(['read-only', 'read-write'])).toBe('read-write');
    expect(grantedScopeOf(new Set(['read-write']))).toBe('read-write');
    expect(grantedScopeOf(['read-only'])).toBe('read-only');
    expect(grantedScopeOf([])).toBe('read-only');
    expect(grantedScopeOf(['READ-WRITE', 'admin'])).toBe('read-only');
  });
});

describe('createAccessTokenVerifier (D10)', () => {
  it('a live token gives AuthInfo: client, scopes, expiry, the resource, and the user, level and grant in extra', async () => {
    const { access } = await issue();
    const before = Math.floor(Date.now() / 1000);
    const auth = await t.verifier.verifyAccessToken(access);
    expect(auth).toMatchObject({ token: access, clientId, scopes: ['read-only', 'read-write'] });
    expect(auth.resource?.href).toBe(RESOURCE);
    expect(auth.expiresAt).toBeGreaterThanOrEqual(before + 3599);
    expect(auth.extra).toMatchObject({ userId: 'ynab-user-1', grantedScope: 'read-write' });
    expect(auth.extra?.['grantId']).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const readOnly = await t.verifier.verifyAccessToken((await issue('read-only')).access);
    expect(readOnly.extra?.['grantedScope']).toBe('read-only');
    expect(readOnly.scopes).toEqual(['read-only']);
  });

  it('refuses an unknown, malformed or non-string value, and a refresh token, with the one invalid_token', async () => {
    const { refresh } = await issue();
    for (const value of ['', 'nope', 'A'.repeat(43), `ymcp1_${'A'.repeat(43)}_${'B'.repeat(22)}`, refresh, 42 as unknown as string]) {
      await expectInvalidToken(t.verifier.verifyAccessToken(value));
    }
  });

  it('refuses an expired token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { access } = await issue();
    vi.setSystemTime(Date.now() + 3601_000);
    await expectInvalidToken(t.verifier.verifyAccessToken(access));
  });

  it('refuses a token bound to another audience, or to none', async () => {
    const { access } = await issue();
    const found = await t.oidc.provider.AccessToken.find(access);
    const client = await t.oidc.provider.Client.find(clientId);
    const forge = async (audience: string | undefined): Promise<string> => {
      const at = new t.oidc.provider.AccessToken({ accountId: 'ynab-user-1', client: client!, grantId: found!.grantId!, scope: 'read-only' });
      if (audience !== undefined) at.resourceServer = new t.oidc.provider.ResourceServer(audience, { scope: 'read-only', audience });
      return at.save();
    };
    await expectInvalidToken(t.verifier.verifyAccessToken(await forge('https://other.example/mcp')));
    await expectInvalidToken(t.verifier.verifyAccessToken(await forge(`${RESOURCE}/`)));
    await expectInvalidToken(t.verifier.verifyAccessToken(await forge(undefined)));
  });

  it("refuses a token whose user was erased (STOR-1) or whose grant was revoked", async () => {
    const a = await issue();
    await storage.deleteUserData('ynab-user-1');
    await expectInvalidToken(t.verifier.verifyAccessToken(a.access));

    const b = await issue();
    const grantId = (await t.verifier.verifyAccessToken(b.access)).extra?.['grantId'] as string;
    await storage.revokeOAuthGrant(grantId);
    await expectInvalidToken(t.verifier.verifyAccessToken(b.access));
  });

  it('a storage failure is refused the same way and logged sanitized, never sent', async () => {
    const { access } = await issue();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = new Proxy(storage, {
      get(target, prop) {
        if (prop === 'findOAuthRow') return async () => Promise.reject(new Error('connect ECONNREFUSED postgres://user:hunter2@db'));
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const broken = buildOidcTestApp(failing);
    const verifier = createAccessTokenVerifier({ provider: broken.oidc.provider, resource: broken.oidc.resource });
    const err = await verifier.verifyAccessToken(access).catch((e: unknown) => e);
    await expectInvalidToken(Promise.reject(err));
    expect(String((err as Error).message)).not.toContain('hunter2');
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls.flat().join(' ')).not.toContain('hunter2');
  });

  it('its refusal is the class the bearer middleware answers 401 with a resource_metadata challenge', async () => {
    const err = await t.verifier.verifyAccessToken('nope').catch((e: unknown) => e);
    const challenge = bearerAuthChallengeResponse(err as never, {
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('WWW-Authenticate')).toContain('invalid_token');
  });
});
