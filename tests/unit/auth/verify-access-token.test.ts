/**
 * The `/mcp` verifier's refusals (WS7.3, ADR-0001 D7 and D14), now
 * `createAccessTokenVerifier` over oidc-provider (ADR-0002 D10).
 *
 * Every refusal, and every failure while verifying, is v2's
 * `OAuthError(InvalidToken)` with one fixed message: the only error the /mcp
 * bearer middleware (`@modelcontextprotocol/express`) answers with 401 and the
 * `resource_metadata` challenge. Upstream text (a storage error, a timeout) is
 * logged sanitized and never reaches the error. The verifier's AuthInfo and
 * its unknown, expired, foreign-audience and erased-user refusals are in
 * tests/unit/auth/oidc/verifier.test.ts; this file keeps WS7.3's failure
 * matrix and D7's no-cache rule. The end-to-end check over /mcp is
 * tests/unit/http-bearer-auth.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bearerAuthChallengeResponse } from '@modelcontextprotocol/server';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { expectInvalidToken } from '../helpers/invalid-token.js';
import { plantAccessToken, plantUser } from '../helpers/oauth-state.js';
import { RESOURCE, buildOidcTestApp, type OidcTestApp } from '../helpers/oidc-app.js';

const RESOURCE_METADATA = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

let storage: MemoryStorage;
let t: OidcTestApp;

beforeEach(async () => {
  storage = new MemoryStorage();
  await storage.init();
  t = buildOidcTestApp(storage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A live read-only access token for a connected user, planted through the library. */
async function seedAccessToken(): Promise<string> {
  await plantUser(storage, { userId: 'ynab-user-1', grantedScope: 'read-write', encryptedRefreshToken: 'x' });
  return plantAccessToken(storage, {
    clientId: 'c1',
    userId: 'ynab-user-1',
    scopes: ['read-only'],
    expiresAt: Date.now() + 60_000,
    resource: RESOURCE,
    grantedScope: 'read-only',
  });
}

/** The status the bearer middleware answers for this rejection (the same mapping @modelcontextprotocol/express uses). */
async function middlewareStatus(verification: Promise<unknown>): Promise<number> {
  const err = await verification.then(
    () => undefined,
    (e: unknown) => e
  );
  return bearerAuthChallengeResponse(err, { resourceMetadataUrl: RESOURCE_METADATA }).status;
}

describe('the verifier maps every failure to the same refusal', () => {
  const failures: Array<[string, unknown]> = [
    ['a storage error with connection details', new Error('connect ECONNREFUSED 10.1.2.3:5432 (postgres://app:hunter2@db.internal/ynab)')],
    ['a Postgres statement timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['a pg client-side query timeout', new Error('Query read timeout')],
    ['a pg pool connection timeout', new Error('timeout exceeded when trying to connect')],
    ['a SQLite busy timeout', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })],
    ['a thrown non-Error value', { detail: 'not an Error' }],
  ];

  it.each(failures)('%s: refused as invalid_token, logged sanitized, nothing upstream in the error', async (_name, failure) => {
    const token = await seedAccessToken();
    vi.spyOn(storage, 'findOAuthRow').mockRejectedValue(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const verification = t.verifier.verifyAccessToken(token);
    await expectInvalidToken(verification);
    const err = await verification.catch((e: unknown) => e);
    expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toMatch(
      /ECONNREFUSED|hunter2|timeout|locked|not an Error/
    );
    expect(await middlewareStatus(t.verifier.verifyAccessToken(token))).toBe(401);

    expect(logged).toHaveBeenCalled();
    for (const line of logged.mock.calls.map((call) => call.map(String).join(' '))) {
      expect(line).toMatch(/^\[OAuth\] Access token verification failed; refused as invalid_token:/);
      expect(line).not.toContain(token);
      expect(line).not.toContain('hunter2');
    }
  });

  it('refuses a stored row it cannot read (a corrupt record) the same way', async () => {
    const token = await seedAccessToken();
    const find = storage.findOAuthRow.bind(storage);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const corrupt of ['{', JSON.stringify({ scope: 42, accountId: 'ynab-user-1' }), '[]']) {
      vi.spyOn(storage, 'findOAuthRow').mockImplementation(async (key) => {
        const row = await find(key);
        return row ? { ...row, payload: corrupt } : row;
      });
      await expectInvalidToken(t.verifier.verifyAccessToken(token));
      expect(await middlewareStatus(t.verifier.verifyAccessToken(token))).toBe(401);
    }
  });

  it('keeps nothing between calls (D7): each call reads storage and returns a fresh AuthInfo', async () => {
    const token = await seedAccessToken();
    const read = vi.spyOn(storage, 'findOAuthRow');
    const first = await t.verifier.verifyAccessToken(token);
    const second = await t.verifier.verifyAccessToken(token);
    expect(read).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.extra).not.toBe(first.extra);
  });
});
