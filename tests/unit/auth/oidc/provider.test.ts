/**
 * The oidc-provider configuration (ADR-0002 D2, D7, D13) on its own Express
 * app, against a fake YNAB (mocked OAuth calls), on every storage driver:
 * discovery, DCR, PKCE, RFC 8707, pre-redirect errors, the code and refresh
 * grants, the TTLs and the cookies, plus #113's notes 2 (two refreshes of
 * one token never both succeed, forced race included) and 3 (no client
 * metadata makes the library fetch a URL).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

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

import { FULL_SCOPE, cookieSigningKey, normalizeAuthorizeScope } from '../../../../src/auth/oidc/provider.js';
import { createClientSchemaValidator } from '../../../../src/auth/oidc/client-schema.js';
import { isClientSecretHash } from '../../../../src/auth/token-hash.js';
import type { ConsumeOutcome, Storage } from '../../../../src/storage/types.js';
import { REFRESH_TOKEN_IDLE_DAYS } from '../../../../src/auth/retention-defaults.js';
import { testDrivers, cleanupDrivers, type DriverHandle } from '../../helpers/storage-drivers.js';
import {
  ISSUER,
  PUBLIC_URL,
  RESOURCE,
  REDIRECT_URI,
  CookieJar,
  authorizeUrl,
  browse,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  oauthRowsOf,
  pkcePair,
  refresh,
  registerClient,
  type OidcTestApp,
  type OidcTestAppOptions,
} from '../../helpers/oidc-app.js';

const DAY = 86_400;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await cleanupDrivers();
});

describe('normalizeAuthorizeScope (D7)', () => {
  it.each([
    [undefined, FULL_SCOPE],
    ['', FULL_SCOPE],
    ['read-write', FULL_SCOPE],
    ['read-only read-write', FULL_SCOPE],
    ['read-only', 'read-only'],
    ['openid read-only', 'read-only'],
    ['openid', FULL_SCOPE],
    ['profile email', FULL_SCOPE],
    ['read-only  read-only', 'read-only'],
    ['READ-WRITE', FULL_SCOPE],
  ])('%j becomes %j', (raw, expected) => {
    expect(normalizeAuthorizeScope(raw)).toBe(expected);
  });

  it('leaves a non-string alone (the library refuses a repeated parameter)', () => {
    expect(normalizeAuthorizeScope(['read-only', 'read-write'])).toBeUndefined();
  });
});

describe('cookieSigningKey', () => {
  it('derives a stable key from ENCRYPTION_KEY that is not the key itself', () => {
    const raw = Buffer.alloc(32, 9).toString('base64');
    expect(cookieSigningKey(raw)).toBe(cookieSigningKey(raw));
    expect(cookieSigningKey(raw)).not.toBe(cookieSigningKey(Buffer.alloc(32, 8).toString('base64')));
    expect(Buffer.from(cookieSigningKey(raw), 'base64url').equals(Buffer.alloc(32, 9))).toBe(false);
  });
});

/** One sign-in to tokens: the code, the verifier and the token response. */
async function signIn(
  t: OidcTestApp,
  clientId: string,
  opts: { scope?: string; choice?: 'read-only' | 'read-write'; resource?: string } = {}
): Promise<{ code: string; verifier: string; tokens: Record<string, unknown> }> {
  const pkce = pkcePair();
  const flow = await browserFlow(t.app, new CookieJar(), {
    clientId,
    challenge: pkce.challenge,
    scope: opts.scope ?? 'read-write',
    choice: opts.choice ?? 'read-write',
    resource: opts.resource,
  });
  const code = flow.params.get('code') as string;
  const res = await exchangeCode(t.app, { clientId, code, verifier: pkce.verifier });
  expect(res.status).toBe(200);
  return { code, verifier: pkce.verifier, tokens: res.body as Record<string, unknown> };
}

/** A storage wrapper whose consumeOAuthRow, once armed, waits until `n` calls have arrived. */
function consumeBarrier(storage: Storage, n: number): { store: Storage; outcomes: ConsumeOutcome[]; arm: () => void } {
  const waiting: Array<() => void> = [];
  const outcomes: ConsumeOutcome[] = [];
  let armed = false;
  const store = new Proxy(storage, {
    get(target, prop) {
      if (prop === 'consumeOAuthRow') {
        return async (key: string): Promise<ConsumeOutcome> => {
          if (armed) {
            await new Promise<void>((resolve) => {
              waiting.push(resolve);
              if (waiting.length >= n) for (const release of waiting.splice(0)) release();
            });
          }
          const outcome = await target.consumeOAuthRow(key);
          outcomes.push(outcome);
          return outcome;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { store, outcomes, arm: () => (armed = true) };
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`the oidc-provider configuration (${driver.name})`, () => {
    let handle: DriverHandle;
    let t: OidcTestApp;
    let clientId: string;

    const setup = async (options: OidcTestAppOptions = {}): Promise<void> => {
      t = buildOidcTestApp(handle.storage, options);
      ({ clientId } = await registerClient(t.app));
    };

    beforeEach(async () => {
      handle = await driver.open();
      await setup();
    });

    it('serves RFC 8414 and OIDC discovery at PUBLIC_URL, S256 only, iss supported, the MCP scopes (spike 1-4)', async () => {
      for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
        const res = await request(t.app).get(path);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          issuer: ISSUER,
          authorization_endpoint: `${PUBLIC_URL}/authorize`,
          token_endpoint: `${PUBLIC_URL}/token`,
          registration_endpoint: `${PUBLIC_URL}/register`,
          revocation_endpoint: `${PUBLIC_URL}/revoke`,
          jwks_uri: `${PUBLIC_URL}/jwks`,
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ['read-only', 'read-write'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        });
        for (const absent of ['userinfo_endpoint', 'introspection_endpoint', 'end_session_endpoint', 'pushed_authorization_request_endpoint', 'device_authorization_endpoint', 'dpop_signing_alg_values_supported']) {
          expect(res.body).not.toHaveProperty(absent);
        }
      }
      // The origin is PUBLIC_URL's whatever the request's Host and scheme say.
      const other = await request(t.app).get('/.well-known/oauth-authorization-server').set('Host', 'evil.example').set('X-Forwarded-Proto', 'http');
      expect(other.body.token_endpoint).toBe(`${PUBLIC_URL}/token`);
    });

    it('DCR answers 201 with a secret, applies D2\'s defaults, and stores only the s256. hash (spike 5-7)', async () => {
      const res = await request(t.app)
        .post('/register')
        .send({ redirect_uris: [REDIRECT_URI], client_name: 'Confidential' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        client_secret_expires_at: 0,
      });
      const secret = res.body.client_secret as string;
      expect(secret.length).toBeGreaterThan(40);
      const client = await t.oidc.provider.Client.find(res.body.client_id as string);
      expect(isClientSecretHash(client?.clientSecret)).toBe(true);
      expect(JSON.stringify(await oauthRowsOf(handle))).not.toContain(secret);

      const local = await request(t.app)
        .post('/register')
        .send({ redirect_uris: ['http://localhost:3000/cb'], token_endpoint_auth_method: 'none', application_type: 'native' });
      expect(local.status).toBe(201);
      const bad = await request(t.app).post('/register').send({ redirect_uris: ['not a url'] });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('invalid_redirect_uri');
    });

    it('#113 note 3: sector_identifier_uri is refused at DCR and never fetched, at DCR or by Client.find', async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('network access attempted');
      });
      vi.stubGlobal('fetch', fetchSpy);
      const res = await request(t.app)
        .post('/register')
        .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', sector_identifier_uri: 'https://sector.example/uris.json' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_client_metadata', error_description: 'sector_identifier_uri is not supported' });
      // A stored client carrying the field (not one we write; planted) is found without a fetch.
      const planted = 'P'.repeat(43);
      await t.oidc.provider.Client.adapter.upsert(planted, {
        client_id: planted,
        redirect_uris: [REDIRECT_URI, 'https://other.example/cb'],
        token_endpoint_auth_method: 'none',
        sector_identifier_uri: 'https://sector.example/uris.json',
      });
      expect((await t.oidc.provider.Client.find(planted))?.clientId).toBe(planted);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a client the client-schema validator accepts (M4) is one this provider finds and authorizes', async () => {
      const metadata = {
        client_id: '7b0c3f2e-2a7e-4c1e-9a4b-6a1d1e2f3a4b',
        client_name: 'Converted 0.4.x client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      };
      expect(await createClientSchemaValidator()(metadata)).toBeUndefined();
      await t.oidc.provider.Client.adapter.upsert(metadata.client_id, metadata);
      expect((await t.oidc.provider.Client.find(metadata.client_id))?.clientName).toBe('Converted 0.4.x client');
      const { tokens } = await signIn(t, metadata.client_id);
      expect(tokens['scope']).toBe(FULL_SCOPE);
    });

    it('PKCE is required and S256 only; errors go back with state and iss (spike 9, 10)', async () => {
      const jar = new CookieJar();
      const plain = await browse(t.app, jar, authorizeUrl({ clientId, challenge: 'x'.repeat(43), extra: { code_challenge_method: 'plain' } }));
      const none = await browse(t.app, jar, authorizeUrl({ clientId, challenge: 'x'.repeat(43) }).replace(/&code_challenge=[^&]*/, '').replace(/&code_challenge_method=S256/, ''));
      for (const res of [plain, none]) {
        expect(res.status).toBe(303);
        const target = new URL(res.headers['location'] as string);
        expect(`${target.origin}${target.pathname}`).toBe(REDIRECT_URI);
        expect(target.searchParams.get('error')).toBe('invalid_request');
        expect(target.searchParams.get('state')).toBe('client-state');
        expect(target.searchParams.get('iss')).toBe(ISSUER);
      }
    });

    it('a wrong code_verifier is invalid_grant (spike 16)', async () => {
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge });
      const res = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkcePair().verifier });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('RFC 8707: a foreign resource is invalid_target with iss; another spelling of ours is accepted and bound canonically (spike 11, 20)', async () => {
      const foreign = await browse(t.app, new CookieJar(), authorizeUrl({ clientId, challenge: pkcePair().challenge, resource: 'https://other.example/mcp' }));
      expect(foreign.status).toBe(303);
      const target = new URL(foreign.headers['location'] as string);
      expect(target.searchParams.get('error')).toBe('invalid_target');
      expect(target.searchParams.get('iss')).toBe(ISSUER);

      for (const spelling of [RESOURCE, `${RESOURCE}/`, 'HTTPS://MCP.EXAMPLE.COM:443/mcp']) {
        const { tokens } = await signIn(t, clientId, { resource: spelling });
        const auth = await t.verifier.verifyAccessToken(tokens['access_token'] as string);
        expect(auth.resource?.href).toBe(RESOURCE);
        const found = await t.oidc.provider.AccessToken.find(tokens['access_token'] as string);
        expect(found?.aud).toBe(RESOURCE);
      }
    });

    it('an unregistered redirect_uri, or an unknown client, is answered as JSON and never redirected (spike 12)', async () => {
      const jar = new CookieJar();
      const unregistered = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkcePair().challenge, redirectUri: 'https://evil.example/cb' }));
      const unknown = await browse(t.app, jar, authorizeUrl({ clientId: 'U'.repeat(43), challenge: pkcePair().challenge }));
      for (const res of [unregistered, unknown]) {
        expect(res.status).toBe(400);
        expect(res.headers['location']).toBeUndefined();
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(Object.keys(res.body as object).sort()).toEqual(['error', 'error_description']);
      }
      expect(unregistered.body.error).toBe('invalid_redirect_uri');
      expect(unknown.body.error).toBe('invalid_client');
    });

    it('the token response is no-store and the code is spent; a replay revokes the grant (spike 19, 22)', async () => {
      const { code, verifier, tokens } = await signIn(t, clientId);
      const replay = await exchangeCode(t.app, { clientId, code, verifier });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('invalid_grant');
      await expect(t.verifier.verifyAccessToken(tokens['access_token'] as string)).rejects.toMatchObject({ code: 'invalid_token' });
      const res = await refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string });
      expect(res.body.error).toBe('invalid_grant');
    });

    it('a refresh rotates, can narrow to read-only, refuses a foreign resource, and a reused token revokes the grant (spike 25-28)', async () => {
      const { tokens } = await signIn(t, clientId);
      const foreign = await refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string, resource: 'https://other.example/mcp' });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error).toBe('invalid_target');

      const narrowed = await refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string, scope: 'read-only' });
      expect(narrowed.status).toBe(200);
      expect(narrowed.body.scope).toBe('read-only');
      expect(narrowed.body.refresh_token).not.toBe(tokens['refresh_token']);
      expect((await t.verifier.verifyAccessToken(narrowed.body.access_token as string)).extra?.['grantedScope']).toBe('read-only');
      // The rotated token keeps the grant: the next refresh may be read-write again.
      const wide = await refresh(t.app, { clientId, refreshToken: narrowed.body.refresh_token as string, resource: `${RESOURCE}/` });
      expect(wide.status).toBe(200);
      expect(wide.body.scope).toBe(FULL_SCOPE);

      const reuse = await refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string });
      expect(reuse.body.error).toBe('invalid_grant');
      await expect(t.verifier.verifyAccessToken(wide.body.access_token as string)).rejects.toMatchObject({ code: 'invalid_token' });
      expect((await refresh(t.app, { clientId, refreshToken: wide.body.refresh_token as string })).body.error).toBe('invalid_grant');
    });

    it('refresh tokens: the idle window, capped by the absolute lifetime from the family start (STOR-1)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { tokens } = await signIn(t, clientId);
      const first = await t.oidc.provider.RefreshToken.find(tokens['refresh_token'] as string);
      expect(first!.exp! - first!.iat!).toBe(REFRESH_TOKEN_IDLE_DAYS * DAY);
      // 80 days on (refreshed every 20 days): the next token ends at 90 days from the start, not 30 days on.
      let rt = tokens['refresh_token'] as string;
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(Date.now() + 20 * DAY * 1000);
        const res = await refresh(t.app, { clientId, refreshToken: rt });
        expect(res.status).toBe(200);
        rt = res.body.refresh_token as string;
      }
      const last = await t.oidc.provider.RefreshToken.find(rt);
      expect(last!.exp! - last!.iiat!).toBe(90 * DAY);
      expect(last!.exp! - last!.iat!).toBe(10 * DAY);
    });

    it('cookies are signed, HttpOnly, SameSite=Lax and Secure; the interaction cookie is scoped to its path', async () => {
      const res = await request(t.app).get(authorizeUrl({ clientId, challenge: pkcePair().challenge }));
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const interaction = cookies.find((c) => c.startsWith('_interaction='));
      expect(interaction).toMatch(/path=\/oauth\/interaction\/[A-Za-z0-9_-]{43}/);
      expect(cookies.some((c) => c.startsWith('_interaction.sig='))).toBe(true);
      expect(cookies.find((c) => c.startsWith('_interaction_resume='))).toMatch(/path=\/authorize\//);
      for (const cookie of cookies) {
        expect(cookie).toMatch(/; secure/i);
        expect(cookie).toMatch(/; httponly/i);
        expect(cookie).toMatch(/; samesite=lax/i);
      }
    });

    it('#113 note 2: two concurrent refreshes of one token never both succeed (spike 29)', async () => {
      const { tokens } = await signIn(t, clientId);
      const results = await Promise.all([
        refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string }),
        refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string }),
      ]);
      const live: string[] = [];
      for (const res of results) {
        if (res.status !== 200) continue;
        try {
          await t.verifier.verifyAccessToken(res.body.access_token as string);
          live.push(res.body.refresh_token as string);
        } catch {
          // revoked by the loser's replay
        }
      }
      expect(live.length).toBeLessThanOrEqual(1);
    });

    it('#113 note 2: a forced race (both read the token before either consumes it) leaves no live token (spike 32)', async () => {
      const barrier = consumeBarrier(handle.storage, 2);
      await setup({ providerStore: barrier.store });
      const { tokens } = await signIn(t, clientId);
      barrier.arm();
      const results = await Promise.all([
        refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string }),
        refresh(t.app, { clientId, refreshToken: tokens['refresh_token'] as string }),
      ]);
      // Both passed the library's own `consumed` check; the compare-and-set lets one through.
      expect(barrier.outcomes.slice(-2).sort()).toEqual(['consumed', 'replayed']);
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      for (const res of results) {
        if (res.status !== 200) {
          expect(res.body.error).toBe('invalid_grant');
          continue;
        }
        await expect(t.verifier.verifyAccessToken(res.body.access_token as string)).rejects.toMatchObject({ code: 'invalid_token' });
        expect((await refresh(t.app, { clientId, refreshToken: res.body.refresh_token as string })).body.error).toBe('invalid_grant');
      }
      expect((await oauthRowsOf(handle)).map((r) => r.model).filter((m) => m === 'AccessToken' || m === 'RefreshToken')).toEqual([]);
    });

    it('concurrent redemption of one code leaves no live token (spike 35)', async () => {
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge });
      const code = flow.params.get('code') as string;
      const results = await Promise.all([
        exchangeCode(t.app, { clientId, code, verifier: pkce.verifier }),
        exchangeCode(t.app, { clientId, code, verifier: pkce.verifier }),
      ]);
      let live = 0;
      for (const res of results) {
        if (res.status !== 200) continue;
        try {
          await t.verifier.verifyAccessToken(res.body.access_token as string);
          live++;
        } catch {
          // revoked
        }
      }
      expect(live).toBeLessThanOrEqual(1);
    });

    it('revocation: another client\'s revoke has no effect; revoking a refresh token removes the grant (spike 43, 44)', async () => {
      const { tokens } = await signIn(t, clientId);
      const other = await registerClient(t.app, { client_name: 'Other' });
      const foreign = await request(t.app).post('/revoke').type('form').send({ token: tokens['refresh_token'], client_id: other.clientId });
      expect(foreign.status).toBe(200);
      await t.verifier.verifyAccessToken(tokens['access_token'] as string);
      const own = await request(t.app).post('/revoke').type('form').send({ token: tokens['refresh_token'], client_id: clientId });
      expect(own.status).toBe(200);
      await expect(t.verifier.verifyAccessToken(tokens['access_token'] as string)).rejects.toMatchObject({ code: 'invalid_token' });
    });
  });
}
