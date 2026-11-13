/**
 * `McpOAuthProvider.verifyAccessToken` refusals (WS7.3, ADR-0001 D7 and D14).
 *
 * Every refusal, and every failure while verifying, is v2's
 * `OAuthError(InvalidToken)` with one fixed message: the only error the /mcp
 * bearer middleware (`@modelcontextprotocol/express`) answers with 401 and the
 * `resource_metadata` challenge. Upstream text (a storage error, a timeout) is
 * logged sanitized and never reaches the error. The end-to-end check over /mcp
 * is tests/unit/http-bearer-auth.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bearerAuthChallengeResponse } from '@modelcontextprotocol/server';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { Encryptor } from '../../../src/crypto.js';
import { McpOAuthProvider } from '../../../src/auth/mcp-provider.js';
import { TEST_TOKEN_HASHER } from '../helpers/token-hasher.js';
import { INVALID_ACCESS_TOKEN_MESSAGE, expectInvalidToken } from '../helpers/invalid-token.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const RESOURCE_METADATA = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

function makeProvider(): { provider: McpOAuthProvider; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const provider = new McpOAuthProvider({
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
  return { provider, storage };
}

/** A live access token for a user that holds it, stored under its hashed key. */
async function seedAccessToken(
  storage: MemoryStorage,
  overrides: { expiresAt?: number; resource?: string } = {}
): Promise<string> {
  await storage.upsertUser({
    userId: 'ynab-user-1',
    grantedScope: 'read-write',
    encryptedRefreshToken: 'x',
    updatedAt: Date.now(),
  });
  const issued = TEST_TOKEN_HASHER.issue('access');
  await storage.saveAccessToken({
    token: issued.key,
    clientId: 'c1',
    userId: 'ynab-user-1',
    scopes: ['read-only'],
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    resource: overrides.resource ?? RESOURCE,
  });
  return issued.value;
}

/** The status the bearer middleware answers for this rejection (the same mapping @modelcontextprotocol/express uses). */
async function middlewareStatus(verification: Promise<unknown>): Promise<{ status: number; challenge: string | null }> {
  const err = await verification.then(
    () => undefined,
    (e: unknown) => e
  );
  const res = bearerAuthChallengeResponse(err, { resourceMetadataUrl: RESOURCE_METADATA });
  return { status: res.status, challenge: res.headers.get('WWW-Authenticate') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyAccessToken refuses with v2 OAuthError(InvalidToken)', () => {
  it('accepts a live token bound to this resource', async () => {
    const { provider, storage } = makeProvider();
    const token = await seedAccessToken(storage);
    const info = await provider.verifyAccessToken(token);
    expect(info.clientId).toBe('c1');
    expect(info.resource?.href).toBe(RESOURCE);
    expect(info.extra).toEqual({ userId: 'ynab-user-1', grantedScope: 'read-only' });
  });

  it.each([
    ['a malformed value', 'not-a-real-token'],
    ['an issued shape with a forged tag', `ymcp1_${'A'.repeat(43)}_${'B'.repeat(22)}`],
    ['an empty string', ''],
  ])('refuses %s without reading storage', async (_name, token) => {
    const { provider, storage } = makeProvider();
    const read = vi.spyOn(storage, 'getAccessToken');
    await expectInvalidToken(provider.verifyAccessToken(token));
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses an unknown token, an expired one and one bound to another resource (RFC 8707)', async () => {
    const { provider, storage } = makeProvider();
    await expectInvalidToken(provider.verifyAccessToken(TEST_TOKEN_HASHER.issue('access').value));
    await expectInvalidToken(provider.verifyAccessToken(await seedAccessToken(storage, { expiresAt: Date.now() - 1_000 })));
    await expectInvalidToken(
      provider.verifyAccessToken(await seedAccessToken(storage, { resource: 'https://mcp.example.com/other' }))
    );
  });

  it('is answered 401 with resource_metadata by the bearer middleware, never 500', async () => {
    const { provider } = makeProvider();
    const { status, challenge } = await middlewareStatus(provider.verifyAccessToken('not-a-real-token'));
    expect(status).toBe(401);
    expect(challenge).toBe(
      `Bearer error="invalid_token", error_description="${INVALID_ACCESS_TOKEN_MESSAGE}", resource_metadata="${RESOURCE_METADATA}"`
    );
  });
});

describe('verifyAccessToken maps every other failure to the same refusal', () => {
  const failures: Array<[string, unknown]> = [
    ['a storage error with connection details', new Error('connect ECONNREFUSED 10.1.2.3:5432 (postgres://app:hunter2@db.internal/ynab)')],
    ['a Postgres statement timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['a pg client-side query timeout', new Error('Query read timeout')],
    ['a pg pool connection timeout', new Error('timeout exceeded when trying to connect')],
    ['a SQLite busy timeout', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })],
    ['a thrown non-Error value', { detail: 'not an Error' }],
  ];

  it.each(failures)('%s: refused as invalid_token, logged sanitized, nothing upstream in the error', async (_name, failure) => {
    const { provider, storage } = makeProvider();
    const token = await seedAccessToken(storage);
    vi.spyOn(storage, 'getAccessToken').mockRejectedValue(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const verification = provider.verifyAccessToken(token);
    await expectInvalidToken(verification);
    const err = await verification.catch((e: unknown) => e);
    expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toMatch(
      /ECONNREFUSED|hunter2|timeout|locked|not an Error/
    );
    expect((await middlewareStatus(provider.verifyAccessToken(token))).status).toBe(401);

    expect(logged).toHaveBeenCalled();
    const lines = logged.mock.calls.map((call) => call.map(String).join(' '));
    for (const line of lines) {
      expect(line).toMatch(/^\[OAuth\] Access token verification failed; refused as invalid_token:/);
      expect(line).not.toContain(token);
      expect(line).not.toContain('hunter2');
    }
  });

  it('refuses a stored row it cannot read (a corrupt record) the same way', async () => {
    const { provider, storage } = makeProvider();
    const token = await seedAccessToken(storage);
    vi.spyOn(storage, 'getAccessToken').mockResolvedValue({
      token: 'k',
      clientId: 'c1',
      userId: 'ynab-user-1',
      scopes: null as unknown as string[],
      expiresAt: Date.now() + 60_000,
      resource: RESOURCE,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expectInvalidToken(provider.verifyAccessToken(token));
  });

  it('keeps nothing between calls (D7): each call reads storage and returns a fresh AuthInfo', async () => {
    const { provider, storage } = makeProvider();
    const token = await seedAccessToken(storage);
    const read = vi.spyOn(storage, 'getAccessToken');
    const first = await provider.verifyAccessToken(token);
    const second = await provider.verifyAccessToken(token);
    expect(read).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.extra).not.toBe(first.extra);
  });
});
