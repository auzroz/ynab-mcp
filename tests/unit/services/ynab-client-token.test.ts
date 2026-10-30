/**
 * YnabClient access-token sources, against the real ynab SDK with fetch stubbed:
 * a token function is called for every request, on both the SDK path and the
 * goal_frequency direct-fetch path; a fixed string token is sent as is.
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

function makeClient(token: AccessTokenSource): YnabClient {
  return new YnabClient(token, 'budget-1', new RateLimiter(180), new Cache(300000), false, new AuditLog());
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

  it('resolves the token per request on the direct-fetch path too', async () => {
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
    const directError = await client.createCategory('budget-1', categoryWithFrequency).catch((e: unknown) => e);

    expect(sdkError).toBeInstanceOf(YnabAuthError);
    expect(directError).toBeInstanceOf(YnabAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(formatErrorResponse(sdkError))).toEqual({
      error: true,
      type: 'auth_error',
      message: 'Could not get YNAB authorization for this request',
      suggestion: 'Try again shortly. If it keeps failing, reconnect this server to YNAB (re-authorize).',
    });
  });
});
