/**
 * #48 Q1 at /mcp: a transient YNAB token failure (a timeout, YNAB 5xx, the
 * circuit breaker, another replica's refresh outlasting the wait) answers 503
 * with Retry-After and keeps the stored grant; only a rejected refresh token
 * (`invalid_grant`) answers the reconnect 401. Only YNAB's token refresh is
 * mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { plantAccessToken, plantUser } from './helpers/oauth-state.js';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, refreshAccessToken: vi.fn() };
});

const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { Encryptor, refreshTokenContext } from '../../src/crypto.js';
import { refreshAccessToken, YnabOAuthError } from '../../src/auth/ynab-oauth.js';
import { CircuitOpenError, OutboundTimeoutError } from '../../src/utils/errors.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { bearer, mcpInitialize, rpcMessage } from './helpers/mcp-call.js';

const refreshMock = vi.mocked(refreshAccessToken);
const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const USER = 'ynab-user-1';
const OK = (): { accessToken: string; refreshToken: string; expiresAt: number } => ({
  accessToken: 'ynab-access',
  refreshToken: 'ynab-refresh-2',
  expiresAt: Date.now() + 7200_000,
});

let handle: HttpApp | undefined;

afterEach(async () => {
  await handle?.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  handle = undefined;
  vi.restoreAllMocks();
  refreshMock.mockReset();
});

async function oauthApp(): Promise<{ app: HttpApp['app']; token: string; storage: Storage }> {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const encryptionKey = randomBytes(32).toString('base64');
  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      authMode: 'oauth',
      oauthClientId: 'cid',
      oauthClientSecret: 'sec',
      encryptionKey,
      tokenPepper: TEST_TOKEN_PEPPER,
    })
  );
  const storage = created.storage!;
  await plantUser(storage, {
    userId: USER,
    grantedScope: 'read-only',
    encryptedRefreshToken: new Encryptor(encryptionKey).encrypt('ynab-refresh-1', refreshTokenContext(USER)),
  });
  const token = await plantAccessToken(storage, {
    clientId: 'client-a',
    userId: USER,
    scopes: ['read-only'],
    expiresAt: Date.now() + 3_600_000,
    resource: RESOURCE,
    grantedScope: 'read-only',
  });
  return { app: handle.app, token, storage };
}

describe('/mcp and transient YNAB token failures (#48 Q1)', () => {
  it.each([
    ['a YNAB timeout', () => new OutboundTimeoutError(false), '5'],
    ['a YNAB 5xx', () => new YnabOAuthError('YNAB token request failed with status 502', 502, undefined), '5'],
    ['YNAB temporarily_unavailable', () => new YnabOAuthError('YNAB token request failed with status 400: temporarily_unavailable', 400, 'temporarily_unavailable'), '5'],
    ['a network error', () => new TypeError('fetch failed'), '5'],
    ['an open circuit breaker', () => new CircuitOpenError(12_300), '13'],
  ])('answers %s with 503 and Retry-After, keeps the grant, and the retry succeeds at once', async (_name, failure, retryAfter) => {
    const { app, token, storage } = await oauthApp();
    const before = (await storage.getUser(USER))?.encryptedRefreshToken;
    refreshMock.mockRejectedValueOnce(failure()).mockResolvedValueOnce(OK());

    const res = await mcpInitialize(app, bearer(token));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe(retryAfter);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(rpcMessage(res)['error']).toMatchObject({ code: -32000 });
    expect((await storage.getUser(USER))?.encryptedRefreshToken).toBe(before);

    // Not remembered as failed: the next request refreshes at once.
    expect((await mcpInitialize(app, bearer(token))).status).toBe(200);
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('a refresh that timed out and then gets invalid_grant (YNAB had rotated the token) answers the reconnect 401', async () => {
    const { app, token, storage } = await oauthApp();
    const before = (await storage.getUser(USER))?.encryptedRefreshToken;
    refreshMock
      .mockRejectedValueOnce(new OutboundTimeoutError(false))
      .mockRejectedValueOnce(new YnabOAuthError('YNAB token request failed with status 400: invalid_grant', 400, 'invalid_grant'));

    expect((await mcpInitialize(app, bearer(token))).status).toBe(503);
    const refused = await mcpInitialize(app, bearer(token));
    expect(refused.status).toBe(401);
    expect(refused.headers['www-authenticate']).toContain('invalid_token');
    expect(refused.headers['retry-after']).toBeUndefined();
    // The dead grant is still stored (a reconnect replaces it), and remembered: no third YNAB call.
    expect((await storage.getUser(USER))?.encryptedRefreshToken).toBe(before);
    expect((await mcpInitialize(app, bearer(token))).status).toBe(401);
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('another rejected refresh (a 401 from the token endpoint) is not transient either', async () => {
    const { app, token } = await oauthApp();
    refreshMock.mockRejectedValueOnce(new YnabOAuthError('YNAB token request failed with status 401: invalid_client', 401, 'invalid_client'));
    expect((await mcpInitialize(app, bearer(token))).status).toBe(401);
  });
});
