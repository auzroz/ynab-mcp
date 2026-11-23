/**
 * YnabClient access-token sources, against the real ynab SDK with fetch stubbed:
 * a token function is called for every request, on both the SDK path and the
 * category write path (goal_frequency); a fixed string token is sent as is.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { YnabAuthError, formatErrorResponse } from '../../../src/utils/errors.js';
import type { AccessTokenSource } from '../../../src/services/ynab-client.js';

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** The bearer token each fetch call carried, in call order. */
function bearerTokens(): (string | null)[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
}

function makeClient(
  token: AccessTokenSource,
  rateLimiter = new RateLimiter(180),
  onUnauthorized?: (rejected: string) => Promise<void>
): YnabClient {
  return new YnabClient(token, 'budget-1', rateLimiter, new Cache(300000), false, new AuditLog(), undefined, undefined, {
    onUnauthorized,
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: { id: '401', name: 'unauthorized', detail: 'Unauthorized' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

const categoryWithFrequency = {
  category: { name: 'Gym', category_group_id: 'group-1', goal_target: 10000, goal_frequency: 'monthly' as const },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('YnabClient token provider', () => {
  it('resolves the token for every SDK request', async () => {
    fetchMock.mockImplementation(async () => json({ data: { user: { id: 'u1' } } }));
    let n = 0;
    const client = makeClient(async () => `token-${++n}`);

    await client.getUser();
    await client.getUser();

    expect(bearerTokens()).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('resolves the token per request on category writes too', async () => {
    fetchMock.mockImplementation(async () => json({ data: { category: { id: 'cat-1' } } }));
    let n = 0;
    const client = makeClient(async () => `token-${++n}`);

    await client.createCategory('budget-1', categoryWithFrequency);
    await client.updateCategory('budget-1', 'cat-1', categoryWithFrequency);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.ynab.com/v1/plans/budget-1/categories',
      'https://api.ynab.com/v1/plans/budget-1/categories/cat-1',
    ]);
    expect(bearerTokens()).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('sends a fixed string token unchanged on both paths', async () => {
    fetchMock.mockImplementation(async (url) =>
      json(String(url).endsWith('/user') ? { data: { user: { id: 'u1' } } } : { data: { category: { id: 'c' } } })
    );
    const client = makeClient('fixed-token');

    await client.getUser();
    await client.createCategory('budget-1', categoryWithFrequency);

    expect(bearerTokens()).toEqual(['Bearer fixed-token', 'Bearer fixed-token']);
  });

  it('fails the call without a request when the token cannot be resolved, with a generic error', async () => {
    const client = makeClient(async () => {
      throw new YnabAuthError();
    });

    const sdkError = await client.getUser().catch((e: unknown) => e);
    const categoryError = await client.createCategory('budget-1', categoryWithFrequency).catch((e: unknown) => e);

    expect(sdkError).toBeInstanceOf(YnabAuthError);
    expect(categoryError).toBeInstanceOf(YnabAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(formatErrorResponse(sdkError))).toEqual({
      error: true,
      type: 'auth_error',
      message: 'Could not get YNAB authorization for this request',
      suggestion: 'Try again shortly. If it keeps failing, reconnect this server to YNAB (re-authorize).',
    });
  });

  it('gives the rate-limit token back when the access token cannot be resolved', async () => {
    const rateLimiter = new RateLimiter(180);
    const client = makeClient(async () => {
      throw new YnabAuthError();
    }, rateLimiter);

    await client.getUser().catch(() => undefined);
    await client.createCategory('budget-1', categoryWithFrequency).catch(() => undefined);

    expect(rateLimiter.getAvailableTokens()).toBe(180);
  });

  describe('a 401 from YNAB in OAuth mode (#48)', () => {
    it('drops the rejected token and fails the call with the mapped auth error', async () => {
      fetchMock.mockImplementation(async () => unauthorized());
      const onUnauthorized = vi.fn(async () => undefined);
      const client = makeClient(async () => 'token-a', undefined, onUnauthorized);

      const error = await client.getUser().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(YnabAuthError);
      expect(JSON.parse(formatErrorResponse(error))).toMatchObject({ type: 'auth_error' });
      expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('token-a');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never retries a write that got a 401', async () => {
      fetchMock.mockImplementation(async () => unauthorized());
      const onUnauthorized = vi.fn(async () => undefined);
      const client = makeClient(async () => 'token-a', undefined, onUnauthorized);

      const error = await client
        .createTransaction('budget-1', {
          transaction: { account_id: 'acct-1', date: '2026-11-01', amount: -1000 },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(YnabAuthError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('still fails the call when dropping the token fails, logging no token', async () => {
      fetchMock.mockImplementation(async () => unauthorized());
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const client = makeClient(async () => 'token-a', undefined, async () => {
        throw new Error('storage down');
      });

      await expect(client.getUser()).rejects.toBeInstanceOf(YnabAuthError);
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('token-a');
    });

    it('without the hook (stdio, header mode), maps a 401 as before', async () => {
      fetchMock.mockImplementation(async () => unauthorized());
      const error = await makeClient('fixed-token').getUser().catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(YnabAuthError);
      expect(JSON.parse(formatErrorResponse(error))).toMatchObject({ code: '401' });
    });
  });

  it('keeps the rate-limit token for a request that was sent', async () => {
    fetchMock.mockImplementation(async () => json({ data: { user: { id: 'u1' } } }));
    const rateLimiter = new RateLimiter(180);
    const client = makeClient(async () => 'token', rateLimiter);

    await client.getUser();

    expect(rateLimiter.getAvailableTokens()).toBe(179);
  });
});
