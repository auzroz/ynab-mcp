/**
 * The YNAB broker as oidc-provider's interaction (ADR-0002 D3, D13), on the
 * provider's own Express app (tests/unit/helpers/oidc-app.ts) against a fake
 * YNAB (the OAuth calls are mocked; nothing reaches the network), on every
 * storage driver:
 *
 *   - the consent page and both access levels, `YNAB_OAUTH_ALLOW_WRITE` and
 *     `YNAB_READ_ONLY`, and D7's scope normalization end to end;
 *   - the browser binding (the library's interaction cookie) and the state,
 *     both checked before the YNAB code is exchanged;
 *   - cancel, a YNAB denial and a failed exchange, each with `state` and `iss`;
 *   - #94: the staged sign-in applied with the code, nothing left by a failure;
 *   - no silent sign-in, a second YNAB user in the same browser, and #113's
 *     first note: a grant left without tokens by an account deletion is never
 *     treated as live.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/auth/ynab-oauth.js')>(
    '../../../../src/auth/ynab-oauth.js'
  );
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn() };
});

import { exchangeCode as ynabExchangeCode, getYnabUserId } from '../../../../src/auth/ynab-oauth.js';
import { Encryptor } from '../../../../src/crypto.js';
import { plainRowKey } from '../../../../src/storage/oauth-rows.js';
import type { OAuthRowWrite, Storage } from '../../../../src/storage/types.js';
import {
  DENIAL_DESCRIPTIONS,
  parseYnabState,
  refreshTokenContext,
  type EncryptionContext,
} from '../../../../src/auth/oidc/interaction.js';
import { REFRESH_TOKEN_TTL_DAYS } from '../../../../src/auth/retention-defaults.js';
import { testDrivers, cleanupDrivers, type DriverHandle } from '../../helpers/storage-drivers.js';
import {
  ISSUER,
  PUBLIC_URL,
  REDIRECT_URI,
  RESOURCE,
  CookieJar,
  authorizeUrl,
  browse,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  interactionUid,
  oauthRowsOf,
  pkcePair,
  refresh,
  registerClient,
  type OidcTestApp,
  type OidcTestAppOptions,
} from '../../helpers/oidc-app.js';

const YNAB_CALLBACK = `${PUBLIC_URL}/oauth/ynab/callback`;

let ynabUser: string;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  ynabUser = 'ynab-user-1';
  vi.mocked(ynabExchangeCode)
    .mockReset()
    .mockImplementation(async () => ({ accessToken: 'ynab-access', refreshToken: `ynab-refresh-${ynabUser}`, expiresAt: Date.now() + 7_200_000 }));
  vi.mocked(getYnabUserId).mockReset().mockImplementation(async () => ynabUser);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

/** Walk the browser up to YNAB: returns the uid and the state `start` sent YNAB. */
async function toYnab(
  t: OidcTestApp,
  jar: CookieJar,
  clientId: string,
  opts: { scope?: string; choice?: string } = {}
): Promise<{ uid: string; state: string; consent: string }> {
  const { challenge } = pkcePair();
  const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge, scope: opts.scope ?? 'read-write' }));
  expect(auth.status).toBe(303);
  const uid = interactionUid(auth.headers['location'] as string);
  const consent = await browse(t.app, jar, `/oauth/interaction/${uid}`);
  expect(consent.status).toBe(200);
  const start = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=${opts.choice ?? 'read-write'}`);
  expect(start.status).toBe(302);
  return { uid, state: new URL(start.headers['location'] as string).searchParams.get('state') as string, consent: consent.text };
}

/** The client redirect after `complete` and the resume, from a `complete` URL. */
async function finish(t: OidcTestApp, jar: CookieJar, completeUrl: string): Promise<URLSearchParams> {
  const complete = await browse(t.app, jar, completeUrl);
  expect(complete.status).toBe(303);
  const resume = await browse(t.app, jar, complete.headers['location'] as string);
  expect(resume.status).toBe(303);
  const target = new URL(resume.headers['location'] as string);
  expect(`${target.origin}${target.pathname}`).toBe(REDIRECT_URI);
  return target.searchParams;
}

/** The phase a state-row write sets ('pending' or 'completing'). */
function phaseOf(row: OAuthRowWrite): string | undefined {
  try {
    return (JSON.parse(row.payload) as { phase?: string }).phase;
  } catch {
    return undefined;
  }
}

/** The access level a pending state-row write records. */
function levelOf(row: OAuthRowWrite): string | undefined {
  try {
    return (JSON.parse(row.payload) as { grantedScope?: string }).grantedScope;
  } catch {
    return undefined;
  }
}

/** Hold the fake YNAB code exchange: `entered` resolves once a call is waiting, `release` lets it finish. */
function holdExchange(): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  const enteredP = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(ynabExchangeCode).mockImplementation(async () => {
    entered();
    await gate;
    return { accessToken: 'ynab-access', refreshToken: 'ynab-refresh-held', expiresAt: Date.now() + 7_200_000 };
  });
  return { entered: enteredP, release };
}

/** A gate that opens once two callers wait at it. */
function twoAtOnce(): () => Promise<void> {
  const waiting: Array<() => void> = [];
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= 2) for (const release of waiting.splice(0)) release();
    });
}

/** The interaction's store over `handle`, with `before` awaited ahead of every compare-and-set. */
function hookedStore(
  handle: DriverHandle,
  before: (row: OAuthRowWrite) => Promise<void> | undefined
): Pick<Storage, 'stageSignIn' | 'findOAuthRow' | 'compareAndSetOAuthRow'> {
  return {
    stageSignIn: (signIn) => handle.storage.stageSignIn(signIn),
    findOAuthRow: (key) => handle.storage.findOAuthRow(key),
    compareAndSetOAuthRow: async (expected, row) => {
      await before(row);
      return handle.storage.compareAndSetOAuthRow(expected, row);
    },
  };
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`the YNAB broker as the interaction (${driver.name})`, () => {
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

    it('a read-write choice: the code carries state and iss, the token is read-only read-write, the sign-in is applied', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge, scope: 'read-write', choice: 'read-write' });
      expect(flow.consentHtml).toContain('/start?scope=read-only');
      expect(flow.consentHtml).toContain('/start?scope=read-write');
      expect(flow.consentHtml).toContain(`/oauth/interaction/${flow.uid}/cancel`);
      // YNAB is asked for full access, with our callback and a state naming this interaction.
      expect(flow.ynabUrl.searchParams.get('redirect_uri')).toBe(YNAB_CALLBACK);
      expect(flow.ynabUrl.searchParams.get('scope')).toBeNull();
      expect(parseYnabState(flow.ynabUrl.searchParams.get('state'))?.uid).toBe(flow.uid);
      expect(flow.params.get('state')).toBe('client-state');
      expect(flow.params.get('iss')).toBe(ISSUER);
      expect(flow.params.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledWith(expect.anything(), { code: 'ynab-code', redirectUri: YNAB_CALLBACK });

      const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.status).toBe(200);
      expect(tokens.body).toMatchObject({ token_type: 'Bearer', scope: 'read-only read-write', expires_in: 3600 });
      expect(tokens.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokens.body).not.toHaveProperty('id_token');

      // #94: the staged sign-in became the user row when the code was saved.
      const user = await handle.storage.getUser('ynab-user-1');
      expect(user?.grantedScope).toBe('read-write');
      expect(user?.encryptedRefreshToken).not.toContain('ynab-refresh');
      const auth = await t.verifier.verifyAccessToken(tokens.body.access_token as string);
      expect(auth.extra).toMatchObject({ userId: 'ynab-user-1', grantedScope: 'read-write' });
    });

    it('a read-only choice gives a read-only token although read-write was requested (spike 18)', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge, scope: 'read-write', choice: 'read-only' });
      expect(flow.ynabUrl.searchParams.get('scope')).toBe('read-only');
      const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only');
      expect((await handle.storage.getUser('ynab-user-1'))?.grantedScope).toBe('read-only');
      // The grant can't be widened by a refresh.
      const widened = await refresh(t.app, { clientId, refreshToken: tokens.body.refresh_token as string, scope: 'read-write' });
      expect(widened.status).toBe(400);
      expect(widened.body.error).toBe('invalid_scope');
    });

    it('no requested scope offers both levels; read-only requested offers only read-only and never grants write (spike 24)', async () => {
      const none = await toYnab(t, new CookieJar(), clientId, { scope: undefined as unknown as string });
      expect(none.consent).toContain('/start?scope=read-write');

      const jar = new CookieJar();
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge, scope: 'read-only', choice: 'read-write' });
      expect(flow.consentHtml).not.toContain('/start?scope=read-write');
      expect(flow.ynabUrl.searchParams.get('scope')).toBe('read-only');
      const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only');
    });

    it('a client sending no scope at all gets both levels (D7)', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge, choice: 'read-write' });
      const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only read-write');
    });

    it('openid, unknown scopes and the OIDC-only parameters are dropped (D7): no ID token, the MCP scopes only', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, jar, {
        clientId,
        challenge: pkce.challenge,
        scope: 'openid profile read-write offline_access',
        choice: 'read-write',
        extra: { nonce: 'n-1', max_age: '60', acr_values: 'urn:x', claims_locales: 'en' },
      });
      const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.status).toBe(200);
      expect(tokens.body.scope).toBe('read-only read-write');
      expect(tokens.body).not.toHaveProperty('id_token');
    });

    it('YNAB_OAUTH_ALLOW_WRITE=false and YNAB_READ_ONLY: no read-write offer, a read-write choice is read-only', async () => {
      for (const options of [{ allowWrite: false }, { globalReadOnly: true }]) {
        await setup(options);
        const jar = new CookieJar();
        const pkce = pkcePair();
        const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge, scope: 'read-write', choice: 'read-write' });
        expect(flow.consentHtml).not.toContain('/start?scope=read-write');
        expect(flow.ynabUrl.searchParams.get('scope')).toBe('read-only');
        const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
        expect(tokens.body.scope).toBe('read-only');
      }
    });

    it('the consent page keeps #55: strict headers, the unverified client "calls itself" its name', async () => {
      const { uid } = await toYnab(t, new CookieJar(), clientId);
      expect(uid).toHaveLength(43);
      const jar = new CookieJar();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkcePair().challenge }));
      const page = await browse(t.app, jar, auth.headers['location'] as string);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.text).toContain('calls itself <strong>“Test Client”</strong>');
      expect(page.text).toContain('client.example');
    });

    it('the browser binding: start, complete and cancel need this browser\'s interaction cookie; YNAB is never called without it (spike 36)', async () => {
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      const stranger = new CookieJar();
      for (const path of [`/oauth/interaction/${uid}`, `/oauth/interaction/${uid}/start?scope=read-only`, `/oauth/interaction/${uid}/cancel`]) {
        expect((await browse(t.app, stranger, path)).status).toBe(400);
      }
      const callback = await browse(t.app, stranger, `/oauth/ynab/callback?code=ynab-code&state=${encodeURIComponent(state)}`);
      expect(callback.status).toBe(302);
      const refused = await browse(t.app, stranger, callback.headers['location'] as string);
      expect(refused.status).toBe(400);
      expect(refused.text).toMatch(/expired or invalid/);
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();

      // A forged (unsigned) cookie is no better than none.
      const forged = await request(t.app)
        .get(`/oauth/interaction/${uid}/complete?code=ynab-code&state=${encodeURIComponent(state)}`)
        .set('Cookie', `_interaction=${uid}`);
      expect(forged.status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();

      // The browser that was shown the consent page still completes.
      const params = await finish(t, jar, callback.headers['location'] as string);
      expect(params.get('code')).toBeTruthy();
    });

    it("another interaction's cookie doesn't complete this one", async () => {
      const jarA = new CookieJar();
      const a = await toYnab(t, jarA, clientId);
      const jarB = new CookieJar();
      const b = await toYnab(t, jarB, clientId);
      // B's browser presents A's state at A's path: B holds no cookie for A's path.
      const res = await browse(t.app, jarB, `/oauth/interaction/${a.uid}/complete?code=x&state=${encodeURIComponent(a.state)}`);
      expect(res.status).toBe(400);
      // B's cookie presented at A's path (by hand), with A's state, is refused too.
      const cookieB = jarB.header(`/oauth/interaction/${b.uid}`);
      const crossed = await request(t.app)
        .get(`/oauth/interaction/${a.uid}/complete?code=x&state=${encodeURIComponent(a.state)}`)
        .set('Cookie', cookieB);
      expect(crossed.status).toBe(400);
      // And B's own path with A's state.
      const swapped = await browse(t.app, jarB, `/oauth/interaction/${b.uid}/complete?code=x&state=${encodeURIComponent(a.state)}`);
      expect(swapped.status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();
    });

    it('a wrong state is refused before the exchange; a replayed callback finds the state spent', async () => {
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      const parsed = parseYnabState(state)!;
      const last = parsed.value.slice(-1);
      const wrong = `${uid}.${parsed.value.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
      for (const s of [wrong, `${uid}.`, 'garbage', state.replace(uid, 'A'.repeat(43))]) {
        const res = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=ynab-code&state=${encodeURIComponent(s)}`);
        expect(res.status).toBe(400);
      }
      expect((await browse(t.app, jar, '/oauth/ynab/callback?code=x&state=garbage')).status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();

      const completeUrl = `/oauth/interaction/${uid}/complete?code=ynab-code&state=${encodeURIComponent(state)}`;
      const params = await finish(t, jar, completeUrl);
      expect(params.get('code')).toBeTruthy();
      const replay = await browse(t.app, jar, completeUrl);
      expect(replay.status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('a repeated or oversized YNAB code is never exchanged: server_error, with state and iss', async () => {
      for (const codes of [['a', 'b'], ['x'.repeat(2049)]]) {
        const jar = new CookieJar();
        const { uid, state } = await toYnab(t, jar, clientId);
        const query = new URLSearchParams({ state });
        for (const c of codes) query.append('code', c);
        const params = await finish(t, jar, `/oauth/interaction/${uid}/complete?${query.toString()}`);
        expect(params.get('error')).toBe('server_error');
        expect(params.get('iss')).toBe(ISSUER);
      }
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();
    });

    it('two concurrent completes with one cookie and state exchange the YNAB code once (atomic spend)', async () => {
      // Both requests pass every check and reach the swap before either makes it.
      const barrier = twoAtOnce();
      await setup({ interactionStore: hookedStore(handle, (row) => (phaseOf(row) === 'completing' ? barrier() : undefined)) });
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      const url = `/oauth/interaction/${uid}/complete?code=ynab-code&state=${encodeURIComponent(state)}`;
      const cookie = jar.header(`/oauth/interaction/${uid}/complete`);
      const results = await Promise.all([
        request(t.app).get(url).set('Cookie', cookie),
        request(t.app).get(url).set('Cookie', cookie),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([303, 400]);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it("a /start racing a complete can't change its choice: the grant and the result are the spent state's", async () => {
      const fresh = new CookieJar();
      const pkce = pkcePair();
      const auth = await browse(t.app, fresh, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
      const uid2 = interactionUid(auth.headers['location'] as string);
      await browse(t.app, fresh, `/oauth/interaction/${uid2}`);
      const start = await browse(t.app, fresh, `/oauth/interaction/${uid2}/start?scope=read-write`);
      const state2 = new URL(start.headers['location'] as string).searchParams.get('state') as string;

      // The YNAB exchange waits until the racing /start has landed.
      let entered!: () => void;
      const inExchange = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.mocked(ynabExchangeCode).mockImplementation(async () => {
        entered();
        await gate;
        return { accessToken: 'ynab-access', refreshToken: 'ynab-refresh-race', expiresAt: Date.now() + 7_200_000 };
      });
      const completing = browse(t.app, fresh, `/oauth/interaction/${uid2}/complete?code=ynab-code&state=${encodeURIComponent(state2)}`);
      await inExchange;
      const late = await browse(t.app, fresh, `/oauth/interaction/${uid2}/start?scope=read-only`);
      expect(late.status).toBe(400);
      release();
      const complete = await completing;
      expect(complete.status).toBe(303);
      // A /start after the outcome is recorded is refused too.
      expect((await browse(t.app, fresh, `/oauth/interaction/${uid2}/start?scope=read-only`)).status).toBe(400);

      const resume = await browse(t.app, fresh, complete.headers['location'] as string);
      const code = new URL(resume.headers['location'] as string).searchParams.get('code') as string;
      const tokens = await exchangeCode(t.app, { clientId, code, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only read-write');
      const authInfo = await t.verifier.verifyAccessToken(tokens.body.access_token as string);
      expect(authInfo.extra?.['grantedScope']).toBe('read-write');
      const grant = await t.oidc.provider.Grant.find(authInfo.extra?.['grantId'] as string);
      expect(grant?.getResourceScopeFiltered(RESOURCE, ['read-only', 'read-write'])).toBe('read-only read-write');
      expect((await handle.storage.getUser('ynab-user-1'))?.grantedScope).toBe('read-write');
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('a new choice spends the previous state: only the latest state completes, with its own level', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
      const uid = interactionUid(auth.headers['location'] as string);
      const first = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-write`);
      const second = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-only`);
      const stateOf = (res: request.Response): string => new URL(res.headers['location'] as string).searchParams.get('state') as string;
      const stale = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(stateOf(first))}`);
      expect(stale.status).toBe(400);
      const params = await finish(t, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(stateOf(second))}`);
      const tokens = await exchangeCode(t.app, { clientId, code: params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only');
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('two concurrent initial /starts: one live choice; only its state completes, with its level', async () => {
      // Both read "no state yet" before either writes.
      const barrier = twoAtOnce();
      await setup({ interactionStore: hookedStore(handle, (row) => (phaseOf(row) === 'pending' ? barrier() : undefined)) });
      const jar = new CookieJar();
      const pkce = pkcePair();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
      const uid = interactionUid(auth.headers['location'] as string);
      const cookie = jar.header(`/oauth/interaction/${uid}/start`);
      const [rw, ro] = await Promise.all([
        request(t.app).get(`/oauth/interaction/${uid}/start?scope=read-write`).set('Cookie', cookie),
        request(t.app).get(`/oauth/interaction/${uid}/start?scope=read-only`).set('Cookie', cookie),
      ]);
      expect([rw.status, ro.status].sort()).toEqual([302, 400]);
      const winner = rw.status === 302 ? rw : ro;
      const loser = winner === rw ? ro : rw;
      const level = winner === rw ? 'read-write' : 'read-only';
      // The refused /start published no state: it never sent the browser to YNAB.
      expect(loser.headers['location']).toBeUndefined();
      const state = new URL(winner.headers['location'] as string).searchParams.get('state') as string;
      const params = await finish(t, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`);
      const tokens = await exchangeCode(t.app, { clientId, code: params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe(level === 'read-write' ? 'read-only read-write' : 'read-only');
      expect((await handle.storage.getUser('ynab-user-1'))?.grantedScope).toBe(level);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it("CodeRabbit's interleaving: a delayed read-only /start that read the choice before a read-write complete swapped in its marker is refused", async () => {
      // The read-only /start reads the row, then waits at its compare-and-set until the complete is inside the YNAB exchange.
      let startWaiting!: () => void;
      const startHeld = new Promise<void>((resolve) => (startWaiting = resolve));
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => (releaseStart = resolve));
      let held = false;
      await setup({
        interactionStore: hookedStore(handle, (row) => {
          if (held || phaseOf(row) !== 'pending' || levelOf(row) !== 'read-only') return undefined;
          held = true;
          startWaiting();
          return startGate;
        }),
      });
      const jar = new CookieJar();
      const pkce = pkcePair();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
      const uid = interactionUid(auth.headers['location'] as string);
      const start = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-write`);
      const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;

      const delayed = request(t.app)
        .get(`/oauth/interaction/${uid}/start?scope=read-only`)
        .set('Cookie', jar.header(`/oauth/interaction/${uid}/start`))
        .then((r) => r);
      await startHeld;

      let entered!: () => void;
      const inExchange = new Promise<void>((resolve) => (entered = resolve));
      let releaseExchange!: () => void;
      const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
      vi.mocked(ynabExchangeCode).mockImplementation(async () => {
        entered();
        await exchangeGate;
        return { accessToken: 'ynab-access', refreshToken: 'ynab-refresh-x', expiresAt: Date.now() + 7_200_000 };
      });
      const completing = browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`);
      await inExchange;
      releaseStart();
      expect((await delayed).status).toBe(400);
      releaseExchange();
      const complete = await completing;
      expect(complete.status).toBe(303);
      const resume = await browse(t.app, jar, complete.headers['location'] as string);
      const code = new URL(resume.headers['location'] as string).searchParams.get('code') as string;
      const tokens = await exchangeCode(t.app, { clientId, code, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only read-write');
      const info = await t.verifier.verifyAccessToken(tokens.body.access_token as string);
      const grant = await t.oidc.provider.Grant.find(info.extra?.['grantId'] as string);
      expect(grant?.getResourceScopeFiltered(RESOURCE, ['read-only', 'read-write'])).toBe('read-only read-write');
      expect((await handle.storage.getUser('ynab-user-1'))?.grantedScope).toBe('read-write');
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('a failed complete leaves the interaction unusable: no new choice, no second complete', async () => {
      vi.mocked(ynabExchangeCode).mockImplementation(async () => {
        throw new Error('YNAB down');
      });
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      const complete = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`);
      expect(complete.status).toBe(303);
      expect((await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-only`)).status).toBe(400);
      expect((await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`)).status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('a cancel before complete wins: the complete is refused, with no exchange and no grant', async () => {
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      const cancel = await browse(t.app, jar, `/oauth/interaction/${uid}/cancel`);
      expect(cancel.status).toBe(303);
      const complete = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`);
      expect(complete.status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();
      expect((await oauthRowsOf(handle)).map((r) => r.model)).not.toContain('Grant');
      // The denial is the outcome the client gets.
      const resume = await browse(t.app, jar, cancel.headers['location'] as string);
      expect(new URL(resume.headers['location'] as string).searchParams.get('error')).toBe('access_denied');
      // And nothing starts again.
      expect((await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-only`)).status).toBe(400);
    });

    it('a cancel while a complete is in the YNAB exchange is refused; the one outcome is the sign-in', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
      const uid = interactionUid(auth.headers['location'] as string);
      const start = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-write`);
      const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;
      const held = holdExchange();
      const completing = browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`);
      await held.entered;
      const cancel = await browse(t.app, jar, `/oauth/interaction/${uid}/cancel`);
      expect(cancel.status).toBe(400);
      held.release();
      const complete = await completing;
      expect(complete.status).toBe(303);
      const resume = await browse(t.app, jar, complete.headers['location'] as string);
      const params = new URL(resume.headers['location'] as string).searchParams;
      expect(params.get('error')).toBeNull();
      const tokens = await exchangeCode(t.app, { clientId, code: params.get('code') as string, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only read-write');
      expect((await oauthRowsOf(handle)).filter((r) => r.model === 'Grant')).toHaveLength(1);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('a YNAB denial racing a complete: whichever claims the state first is the one outcome', async () => {
      // The code first: the denial is refused, the sign-in stands.
      {
        const jar = new CookieJar();
        const pkce = pkcePair();
        const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
        const uid = interactionUid(auth.headers['location'] as string);
        const start = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-write`);
        const state = encodeURIComponent(new URL(start.headers['location'] as string).searchParams.get('state') as string);
        const held = holdExchange();
        const completing = browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${state}`);
        await held.entered;
        const denial = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?error=access_denied&state=${state}`);
        expect(denial.status).toBe(400);
        held.release();
        const complete = await completing;
        const resume = await browse(t.app, jar, complete.headers['location'] as string);
        expect(new URL(resume.headers['location'] as string).searchParams.get('code')).toBeTruthy();
      }
      // The denial first: the code is refused before any exchange, and no grant is saved.
      {
        vi.mocked(ynabExchangeCode).mockClear();
        const before = (await oauthRowsOf(handle)).filter((r) => r.model === 'Grant').length;
        const jar = new CookieJar();
        const { uid, state } = await toYnab(t, jar, clientId);
        const enc = encodeURIComponent(state);
        const denial = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?error=access_denied&state=${enc}`);
        expect(denial.status).toBe(303);
        expect((await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${enc}`)).status).toBe(400);
        const resume = await browse(t.app, jar, denial.headers['location'] as string);
        expect(new URL(resume.headers['location'] as string).searchParams.get('error')).toBe('access_denied');
        expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();
        expect((await oauthRowsOf(handle)).filter((r) => r.model === 'Grant')).toHaveLength(before);
      }
    });

    it("CodeRabbit's sequence: an initial /start held until the other start's complete is in the YNAB exchange is refused", async () => {
      // The read-only /start reads "no state yet" and is held at its compare-and-set.
      let startWaiting!: () => void;
      const startHeld = new Promise<void>((resolve) => (startWaiting = resolve));
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => (releaseStart = resolve));
      let holding = false;
      await setup({
        interactionStore: hookedStore(handle, (row) => {
          if (holding || phaseOf(row) !== 'pending' || levelOf(row) !== 'read-only') return undefined;
          holding = true;
          startWaiting();
          return startGate;
        }),
      });
      const jar = new CookieJar();
      const pkce = pkcePair();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkce.challenge, scope: 'read-write' }));
      const uid = interactionUid(auth.headers['location'] as string);
      const cookie = jar.header(`/oauth/interaction/${uid}/start`);
      const delayed = request(t.app).get(`/oauth/interaction/${uid}/start?scope=read-only`).set('Cookie', cookie).then((r) => r);
      await startHeld;
      // The other initial /start goes through, and its complete reaches the YNAB exchange.
      const start = await browse(t.app, jar, `/oauth/interaction/${uid}/start?scope=read-write`);
      expect(start.status).toBe(302);
      const state = new URL(start.headers['location'] as string).searchParams.get('state') as string;
      const held = holdExchange();
      const completing = browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=c&state=${encodeURIComponent(state)}`);
      await held.entered;
      releaseStart();
      const late = await delayed;
      expect(late.status).toBe(400);
      expect(late.headers['location']).toBeUndefined();
      held.release();
      const complete = await completing;
      expect(complete.status).toBe(303);
      const resume = await browse(t.app, jar, complete.headers['location'] as string);
      const code = new URL(resume.headers['location'] as string).searchParams.get('code') as string;
      const tokens = await exchangeCode(t.app, { clientId, code, verifier: pkce.verifier });
      expect(tokens.body.scope).toBe('read-only read-write');
      expect((await handle.storage.getUser('ynab-user-1'))?.grantedScope).toBe('read-write');
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('a state presented twice in flight is spent by the first (only one exchange)', async () => {
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      vi.mocked(ynabExchangeCode).mockImplementation(async () => {
        throw new Error('YNAB says no: secret-text');
      });
      const url = `/oauth/interaction/${uid}/complete?code=ynab-code&state=${encodeURIComponent(state)}`;
      const first = await browse(t.app, jar, url);
      expect(first.status).toBe(303);
      expect((await browse(t.app, jar, url)).status).toBe(400);
      expect(vi.mocked(ynabExchangeCode)).toHaveBeenCalledTimes(1);
    });

    it('Cancel answers access_denied with state and iss (spike 37)', async () => {
      const jar = new CookieJar();
      const auth = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkcePair().challenge }));
      const uid = interactionUid(auth.headers['location'] as string);
      const cancel = await browse(t.app, jar, `/oauth/interaction/${uid}/cancel`);
      expect(cancel.status).toBe(303);
      const resume = await browse(t.app, jar, cancel.headers['location'] as string);
      const target = new URL(resume.headers['location'] as string);
      expect(Object.fromEntries(target.searchParams)).toEqual({
        error: 'access_denied',
        error_description: DENIAL_DESCRIPTIONS.access_denied,
        state: 'client-state',
        iss: ISSUER,
      });
    });

    it('a YNAB denial is access_denied, any other YNAB error server_error; YNAB text is never forwarded', async () => {
      for (const [ynabError, expected] of [['access_denied', 'access_denied'], ['temporarily_unavailable', 'server_error']] as const) {
        const jar = new CookieJar();
        const pkce = pkcePair();
        const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge, ynabError });
        expect(Object.fromEntries(flow.params)).toEqual({
          error: expected,
          error_description: DENIAL_DESCRIPTIONS[expected],
          state: 'client-state',
          iss: ISSUER,
        });
      }
      expect(vi.mocked(ynabExchangeCode)).not.toHaveBeenCalled();
    });

    it('a failed YNAB exchange is server_error with a fixed description, and leaves no grant or sign-in', async () => {
      vi.mocked(ynabExchangeCode).mockImplementation(async () => {
        throw new Error('YNAB token request failed with status 500: upstream detail');
      });
      const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkcePair().challenge });
      expect(flow.params.get('error')).toBe('server_error');
      expect(flow.params.get('error_description')).toBe(DENIAL_DESCRIPTIONS.server_error);
      expect(flow.params.get('iss')).toBe(ISSUER);
      const models = (await oauthRowsOf(handle)).map((r) => r.model);
      expect(models).not.toContain('Grant');
      expect(models).not.toContain('SignIn');
      expect(models).not.toContain('AuthorizationCode');
    });

    it('a grant revoked before its sign-in is staged: server_error, and the grant is gone', async () => {
      await setup({
        interactionStore: {
          stageSignIn: async () => false,
          findOAuthRow: (key) => handle.storage.findOAuthRow(key),
          compareAndSetOAuthRow: (expected, row) => handle.storage.compareAndSetOAuthRow(expected, row),
        },
      });
      const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkcePair().challenge });
      expect(flow.params.get('error')).toBe('server_error');
      expect((await oauthRowsOf(handle)).map((r) => r.model)).not.toContain('Grant');
      expect(await handle.storage.getUser('ynab-user-1')).toBeUndefined();
    });

    it('#94: a client removed before the resume gets no code, and the sign-in changes no user', async () => {
      const jar = new CookieJar();
      const { uid, state } = await toYnab(t, jar, clientId);
      const complete = await browse(t.app, jar, `/oauth/interaction/${uid}/complete?code=ynab-code&state=${encodeURIComponent(state)}`);
      expect(complete.status).toBe(303);
      await handle.storage.destroyOAuthRow(plainRowKey('Client', clientId));
      const resume = await browse(t.app, jar, complete.headers['location'] as string);
      expect(resume.status).toBeGreaterThanOrEqual(400);
      expect(resume.headers['location']).toBeUndefined();
      expect(await handle.storage.getUser('ynab-user-1')).toBeUndefined();
      expect((await oauthRowsOf(handle)).map((r) => r.model)).not.toContain('AuthorizationCode');
    });

    it('the YNAB refresh token is encrypted under the users column context, for the YNAB user (#57b)', async () => {
      const encryptor = new Encryptor(Buffer.alloc(32, 3).toString('base64'));
      const encrypt = vi.spyOn(encryptor, 'encrypt');
      await setup({ encryptor });
      await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkcePair().challenge });
      expect(encrypt).toHaveBeenCalledWith('ynab-refresh-ynab-user-1', {
        column: 'users.encrypted_refresh_token',
        subject: 'ynab-user-1',
      });
      const user = await handle.storage.getUser('ynab-user-1');
      // With the same context (#57b: required once it lands; today's Encryptor ignores it).
      const decrypt = encryptor.decrypt.bind(encryptor) as (ct: string, context: EncryptionContext) => string;
      expect(decrypt(user!.encryptedRefreshToken, refreshTokenContext('ynab-user-1'))).toBe('ynab-refresh-ynab-user-1');
    });

    it('no silent sign-in: a browser that just signed in goes through consent and YNAB again', async () => {
      const jar = new CookieJar();
      await browserFlow(t.app, jar, { clientId, challenge: pkcePair().challenge });
      expect(jar.names()).toContain('_session');
      const again = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkcePair().challenge }));
      expect(again.status).toBe(303);
      expect(() => interactionUid(again.headers['location'] as string)).not.toThrow();
    });

    it('a second YNAB user in the same browser signs in as themselves (no logout prompt)', async () => {
      const jar = new CookieJar();
      const first = pkcePair();
      const a = await browserFlow(t.app, jar, { clientId, challenge: first.challenge });
      ynabUser = 'ynab-user-2';
      const second = pkcePair();
      const b = await browserFlow(t.app, jar, { clientId, challenge: second.challenge });
      const ta = await exchangeCode(t.app, { clientId, code: a.params.get('code') as string, verifier: first.verifier });
      const tb = await exchangeCode(t.app, { clientId, code: b.params.get('code') as string, verifier: second.verifier });
      expect((await t.verifier.verifyAccessToken(ta.body.access_token as string)).extra?.['userId']).toBe('ynab-user-1');
      expect((await t.verifier.verifyAccessToken(tb.body.access_token as string)).extra?.['userId']).toBe('ynab-user-2');
    });

    it('#113 note 1: a grant left without tokens after deleteUserData is never treated as live', async () => {
      const jar = new CookieJar();
      const pkce = pkcePair();
      const flow = await browserFlow(t.app, jar, { clientId, challenge: pkce.challenge });
      const tokens = await exchangeCode(t.app, { clientId, code: flow.params.get('code') as string, verifier: pkce.verifier });
      const auth = await t.verifier.verifyAccessToken(tokens.body.access_token as string);
      const grantId = auth.extra?.['grantId'] as string;
      const grant = await t.oidc.provider.Grant.find(grantId);
      expect(grant).toBeDefined();
      // A finite lifetime: the absolute window plus the sign-in window, so it outlives its tokens and still expires.
      expect(grant!.exp! - grant!.iat!).toBe(REFRESH_TOKEN_TTL_DAYS * 86_400 + 2 * 600);

      // The browser's library session names the grant for this client.
      const session = await t.oidc.provider.Session.find(jar.value('_session') as string);
      expect(session?.grantIdFor(clientId)).toBe(grantId);

      await handle.storage.deleteUserData('ynab-user-1');
      // What a sign-in racing the deletion leaves: the Grant (and the session naming it) re-saved, no token, no user.
      await grant!.save();
      await session!.save(600);
      const left = (await oauthRowsOf(handle)).filter((r) => r.accountId === 'ynab-user-1' || r.grantId === grantId);
      expect(left.map((r) => r.model).sort()).toEqual(['Grant', 'Session']);

      await expect(t.verifier.verifyAccessToken(tokens.body.access_token as string)).rejects.toMatchObject({ code: 'invalid_token' });
      const refreshed = await refresh(t.app, { clientId, refreshToken: tokens.body.refresh_token as string });
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe('invalid_grant');
      // The same browser, the same client: the interaction again, never a code from the leftover grant.
      const again = await browse(t.app, jar, authorizeUrl({ clientId, challenge: pkcePair().challenge }));
      expect(again.status).toBe(303);
      expect(() => interactionUid(again.headers['location'] as string)).not.toThrow();
      // Not an account connection either.
      expect(await handle.storage.listConnections('ynab-user-1')).toEqual([]);
    });
  });
}
