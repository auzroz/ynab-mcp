/**
 * Authorization-code replay (RFC 9700 section 4.2.4, issue #42) over
 * oidc-provider and the adapter (ADR-0002 D4, D6), on every storage driver:
 * memory always, SQLite when better-sqlite3 loads, Postgres when DATABASE_URL
 * is set (REQUIRE_DB_TESTS=1 makes a missing driver fail instead of skip).
 *
 * The library runs on its own Express app (tests/unit/helpers/oidc-app.ts),
 * without the AS stages: what is checked here is the library's consumed check
 * and the adapter's compare-and-set consume and grant check. The races at the
 * adapter (a replay between the consume and the token saves, two concurrent
 * redemptions) are in tests/unit/storage/oauth-adapter-conformance.test.ts and
 * tests/unit/auth/oidc/provider.test.ts; another client's code and a replay
 * after expiry are `grant-guard`'s (tests/unit/http-oauth-cutover.test.ts).
 * Only the YNAB network calls are mocked.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>('../../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn() };
});

import { exchangeCode as ynabExchangeCode, getYnabUserId } from '../../../src/auth/ynab-oauth.js';
import { testDrivers, cleanupDrivers } from '../helpers/storage-drivers.js';
import { expectInvalidToken } from '../helpers/invalid-token.js';
import {
  CookieJar,
  browserFlow,
  buildOidcTestApp,
  exchangeCode,
  pkcePair,
  refresh,
  registerClient,
  type OidcTestApp,
} from '../helpers/oidc-app.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(ynabExchangeCode)
    .mockReset()
    .mockImplementation(async () => ({ accessToken: 'ynab-access', refreshToken: 'ynab-refresh', expiresAt: Date.now() + 7_200_000 }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue('ynab-user-1');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

interface Issued {
  code: string;
  verifier: string;
  access: string;
  refresh: string;
}

/** One sign-in for `clientId` and its code exchange. */
async function signIn(t: OidcTestApp, clientId: string): Promise<Issued> {
  const pkce = pkcePair();
  const flow = await browserFlow(t.app, new CookieJar(), { clientId, challenge: pkce.challenge });
  const code = flow.params.get('code') as string;
  const res = await exchangeCode(t.app, { clientId, code, verifier: pkce.verifier });
  expect(res.status).toBe(200);
  return { code, verifier: pkce.verifier, access: res.body.access_token as string, refresh: res.body.refresh_token as string };
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`authorization-code replay: ${driver.name}`, () => {
    let t: OidcTestApp;
    let clientId: string;

    beforeEach(async () => {
      t = buildOidcTestApp((await driver.open()).storage);
      ({ clientId } = await registerClient(t.app));
    });

    it('replaying a code revokes the tokens it produced and every token refreshed from them', async () => {
      const first = await signIn(t, clientId);
      const rotated = await refresh(t.app, { clientId, refreshToken: first.refresh });
      expect(rotated.status).toBe(200);

      const replay = await exchangeCode(t.app, { clientId, code: first.code, verifier: first.verifier });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('invalid_grant');
      await expectInvalidToken(t.verifier.verifyAccessToken(first.access));
      await expectInvalidToken(t.verifier.verifyAccessToken(rotated.body.access_token as string));
      expect((await refresh(t.app, { clientId, refreshToken: rotated.body.refresh_token as string })).body.error).toBe(
        'invalid_grant'
      );
    });

    it("leaves the user's other grants alone, for the same client and for another client", async () => {
      const replayed = await signIn(t, clientId);
      const sameClient = await signIn(t, clientId);
      const other = (await registerClient(t.app, { client_name: 'Other' })).clientId;
      const otherClient = await signIn(t, other);

      await exchangeCode(t.app, { clientId, code: replayed.code, verifier: replayed.verifier });
      await expectInvalidToken(t.verifier.verifyAccessToken(replayed.access));
      await expect(t.verifier.verifyAccessToken(sameClient.access)).resolves.toMatchObject({ clientId });
      await expect(t.verifier.verifyAccessToken(otherClient.access)).resolves.toMatchObject({ clientId: other });
      expect((await refresh(t.app, { clientId, refreshToken: sameClient.refresh })).status).toBe(200);
    });

    it('answers unknown, replayed and re-replayed codes identically', async () => {
      const { code, verifier } = await signIn(t, clientId);
      const unknown = await exchangeCode(t.app, { clientId, code: pkcePair().verifier.slice(0, 43), verifier });
      const replayed = await exchangeCode(t.app, { clientId, code, verifier });
      const again = await exchangeCode(t.app, { clientId, code, verifier });
      for (const res of [unknown, replayed, again]) {
        expect(res.status).toBe(400);
        expect(res.body).toEqual(unknown.body);
      }
      expect(unknown.body).toEqual({ error: 'invalid_grant', error_description: 'grant request is invalid' });
    });
  });
}
