/**
 * #64b, on every storage driver: when YNAB refuses the stored refresh token
 * for good, YnabTokenResolver writes one `YnabTokenRejected` marker keyed to
 * that exact ciphertext, so the next sign-in replaces the dead token even
 * when it is read-only and another read-write grant is live. A transient
 * failure, a refusal other than `invalid_grant`, or a ciphertext this replica
 * can't open writes none; an erasure during the YNAB call leaves none; a
 * rekey during it gets the new ciphertext marked too; a failed
 * write leaves the caller's error as it was. Only the YNAB token call is
 * mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>(
    '../../../src/auth/ynab-oauth.js'
  );
  return { ...actual, refreshAccessToken: vi.fn() };
});

import { Encryptor, refreshTokenContext } from '../../../src/crypto.js';
import { YnabTokenResolver, YnabTokenUnavailableError } from '../../../src/auth/user-session.js';
import { OutboundTimeoutError } from '../../../src/utils/errors.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';
import { YnabOAuthError } from '../../../src/auth/ynab-oauth.js';
import { rejectedYnabTokenKey } from '../../../src/storage/oauth-rows.js';
import type { OAuthRowRecord } from '../../../src/storage/types.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from '../helpers/storage-drivers.js';
import { complete, stored, type Store } from '../helpers/sign-in.js';

const refreshMock = vi.mocked(ynabOauth.refreshAccessToken);
const YNAB = { clientId: 'cid', clientSecret: 'sec' };
const HOUR = 3_600_000;
const MARKER_TTL = 24 * HOUR;
const invalidGrant = (): YnabOAuthError =>
  new YnabOAuthError('YNAB token request failed with status 400: invalid_grant', 400, 'invalid_grant');

/** Every `oauth_rows` row, every column as text. */
async function allRows(h: DriverHandle): Promise<Array<Record<string, string>>> {
  const text = (row: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === undefined || v === null ? '' : String(v)]));
  if (h.sql) return (await h.sql('SELECT * FROM oauth_rows')).map(text);
  const map = (h.storage as unknown as { oauthRows: Map<string, OAuthRowRecord> }).oauthRows;
  return [...map.values()].map((r) => text({ ...r }));
}

async function markers(h: DriverHandle): Promise<Array<Record<string, string>>> {
  return (await allRows(h)).filter((r) => r['model'] === 'YnabTokenRejected');
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDrivers();
});

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`#64b: a YNAB token YNAB refused (${driver.name})`, () => {
    const encryptor = new Encryptor(randomBytes(32).toString('base64'));
    const ciphertext = (token: string, userId = 'u1'): string => encryptor.encrypt(token, refreshTokenContext(userId));

    function resolver(h: DriverHandle, now: () => number = Date.now): YnabTokenResolver {
      return new YnabTokenResolver(h.storage, encryptor, YNAB, now, {}, { rejectedTokenMarkerTtlMs: MARKER_TTL });
    }

    it('a read-write token YNAB refuses, then a read-only sign-in while the read-write grant is live: the read-only token replaces it', async () => {
      const h = await driver.open();
      const store = h.storage as Store;
      const rw = ciphertext('rt-rw');
      await complete(store, 'u1', 'read-write', rw);
      refreshMock.mockRejectedValueOnce(invalidGrant());
      await expect(resolver(h).resolve('u1')).rejects.toThrow('invalid_grant');

      const ro = ciphertext('rt-ro');
      await complete(store, 'u1', 'read-only', ro);
      expect(await stored(store, 'u1')).toEqual({ token: ro, scope: 'read-only' });
      // And YNAB access works again, from the new token.
      refreshMock.mockResolvedValueOnce({ accessToken: 'access-ro', refreshToken: 'rt-ro-2', expiresAt: Date.now() + HOUR });
      expect(await resolver(h).resolve('u1')).toMatchObject({ accessToken: 'access-ro', grantedScope: 'read-only' });
      expect(refreshMock).toHaveBeenLastCalledWith(YNAB, 'rt-ro');
    });

    it('a refusal writes exactly one marker, keyed to the refused ciphertext, with no token value in any column', async () => {
      const h = await driver.open();
      const rw = ciphertext('rt-secret-value');
      await complete(h.storage as Store, 'u1', 'read-write', rw);
      let now = Date.now();
      const r = resolver(h, () => now);
      refreshMock.mockRejectedValue(invalidGrant());
      await expect(r.resolve('u1')).rejects.toThrow('invalid_grant');
      // Refused again once the remembered failure has run out: still one row.
      now += 60_000;
      await expect(r.resolve('u1')).rejects.toThrow('invalid_grant');
      expect(refreshMock).toHaveBeenCalledTimes(2);

      const found = await markers(h);
      expect(found).toHaveLength(1);
      const marker = found[0] as Record<string, string>;
      expect(marker['key']).toBe(rejectedYnabTokenKey('u1', rw));
      expect(marker['account_id'] ?? marker['accountId']).toBe('u1');
      expect(marker['payload']).toBe('{}');
      expect(Number(marker['expires_at'] ?? marker['expiresAt'])).toBe(now + MARKER_TTL);
      for (const value of Object.values(marker)) {
        expect(value).not.toContain('rt-secret-value');
        expect(value).not.toContain(rw);
      }
      // #60b: the marker is not a revocation of an MCP grant, so the audit log has no row for it.
      expect(await h.storage.listAuditEntries('u1', {}, 10)).toEqual([]);
    });

    it.each([
      ['a YNAB 503', () => new YnabOAuthError('YNAB token request failed with status 503', 503)],
      ['a 429', () => new YnabOAuthError('YNAB token request failed with status 429', 429)],
      ['temporarily_unavailable', () => new YnabOAuthError('temporarily_unavailable', 400, 'temporarily_unavailable')],
      ['a timeout', () => new OutboundTimeoutError(true)],
    ])('a transient failure (%s) writes no marker', async (_name, error) => {
      const h = await driver.open();
      await complete(h.storage as Store, 'u1', 'read-write', ciphertext('rt-rw'));
      refreshMock.mockRejectedValueOnce(error());
      await expect(resolver(h).resolve('u1')).rejects.toBeInstanceOf(YnabTokenUnavailableError);
      expect(await markers(h)).toEqual([]);
    });

    it.each([
      ['invalid_client', () => new YnabOAuthError('YNAB token request failed with status 401: invalid_client', 401, 'invalid_client')],
      ['a 400 with no OAuth error', () => new YnabOAuthError('YNAB token request failed with status 400', 400)],
    ])("a refusal other than invalid_grant (%s) writes no marker: it may be this server's fault", async (_name, error) => {
      const h = await driver.open();
      await complete(h.storage as Store, 'u1', 'read-write', ciphertext('rt-rw'));
      refreshMock.mockRejectedValueOnce(error());
      await expect(resolver(h).resolve('u1')).rejects.toBeInstanceOf(YnabOAuthError);
      expect(await markers(h)).toEqual([]);
    });

    it("a ciphertext this replica can't open writes no marker (another replica's key may open it)", async () => {
      const h = await driver.open();
      const elsewhere = new Encryptor(randomBytes(32).toString('base64'));
      await complete(h.storage as Store, 'u1', 'read-write', elsewhere.encrypt('rt-rw', refreshTokenContext('u1')));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(resolver(h).resolve('u1')).rejects.toThrow();
      expect(refreshMock).not.toHaveBeenCalled();
      expect(await markers(h)).toEqual([]);
    });

    it('an account erased during the YNAB call is left with no marker', async () => {
      const h = await driver.open();
      await complete(h.storage as Store, 'u1', 'read-write', ciphertext('rt-rw'));
      const gate = deferred<void>();
      refreshMock.mockImplementationOnce(async () => {
        await gate.promise;
        throw invalidGrant();
      });
      const pending = resolver(h).resolve('u1');
      await until(() => refreshMock.mock.calls.length === 1);
      expect(await h.storage.deleteUserData('u1')).toBe(true);
      gate.resolve();
      await expect(pending).rejects.toThrow('invalid_grant');
      expect(await markers(h)).toEqual([]);
      expect(Object.values(await h.userRows('u1')).reduce((a, b) => a + b, 0)).toBe(0);
    });

    it('a rekey of the token during the YNAB call: the re-encrypted token is marked too, and a read-only sign-in replaces it', async () => {
      const h = await driver.open();
      const store = h.storage as Store;
      const before = ciphertext('rt-rw');
      await complete(store, 'u1', 'read-write', before);
      const rekeyed = ciphertext('rt-rw');
      const gate = deferred<void>();
      refreshMock.mockImplementationOnce(async () => {
        await gate.promise;
        throw invalidGrant();
      });
      const pending = resolver(h).resolve('u1');
      await until(() => refreshMock.mock.calls.length === 1);
      // The lease holds, so the rekey job's compare-and-set is the only other writer.
      expect(await store.rekeyUserRefreshToken('u1', before, rekeyed)).toBe(true);
      gate.resolve();
      await expect(pending).rejects.toThrow('invalid_grant');
      expect((await markers(h)).map((r) => r['key']).sort()).toEqual(
        [rejectedYnabTokenKey('u1', before), rejectedYnabTokenKey('u1', rekeyed)].sort()
      );
      const ro = ciphertext('rt-ro');
      await complete(store, 'u1', 'read-only', ro);
      expect(await stored(store, 'u1')).toEqual({ token: ro, scope: 'read-only' });
    });

    it('a newer token stored during the YNAB call is not marked', async () => {
      const h = await driver.open();
      const store = h.storage as Store;
      await complete(store, 'u1', 'read-write', ciphertext('rt-rw'));
      const gate = deferred<void>();
      refreshMock.mockImplementationOnce(async () => {
        await gate.promise;
        throw invalidGrant();
      });
      const pending = resolver(h).resolve('u1');
      await until(() => refreshMock.mock.calls.length === 1);
      const newer = ciphertext('rt-rw-new');
      await complete(store, 'u1', 'read-write', newer);
      gate.resolve();
      await expect(pending).rejects.toThrow('invalid_grant');
      expect((await markers(h)).map((r) => r['key'])).not.toContain(rejectedYnabTokenKey('u1', newer));
      await complete(store, 'u1', 'read-only', ciphertext('rt-ro'));
      expect(await stored(store, 'u1')).toEqual({ token: newer, scope: 'read-write' });
    });

    it("a failed marker write leaves the caller's error unchanged and logs no value", async () => {
      const h = await driver.open();
      const rw = ciphertext('rt-secret-value');
      await complete(h.storage as Store, 'u1', 'read-write', rw);
      const refused = invalidGrant();
      refreshMock.mockRejectedValueOnce(refused);
      const write = vi.spyOn(h.storage, 'upsertOAuthRow').mockRejectedValue(new Error(`storage down ${rw}`));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(resolver(h).resolve('u1')).rejects.toBe(refused);
      expect(write).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalled();
      for (const call of logged.mock.calls) {
        const line = call.map(String).join(' ');
        expect(line).not.toContain('rt-secret-value');
        expect(line).not.toContain(rw);
        expect(line).not.toContain('storage down');
      }
      expect(await markers(h)).toEqual([]);
      // Through the token function a tool call uses: the same mapped error as without a marker.
      refreshMock.mockRejectedValueOnce(invalidGrant());
      await expect(resolver(h).accessTokenFor('u1')()).rejects.toThrow(/YNAB/);
    });
  });
}
