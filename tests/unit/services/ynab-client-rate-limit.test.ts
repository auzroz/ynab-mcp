/**
 * YNAB 429 handling, against the real ynab SDK with fetch stubbed: a 429 on the
 * SDK path or the goal_frequency direct-fetch path marks the user's RateLimiter
 * exhausted (Retry-After honoured), later calls fail fast without a request,
 * and the mapped error carries retry_after_seconds and no upstream text.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { RateLimitError, YnabApiError, formatErrorResponse } from '../../../src/utils/errors.js';

const fetchMock = vi.fn<typeof fetch>();
const clock = { t: 5_000_000 };

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function tooMany(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ error: { id: '429', name: 'too_many_requests', detail: 'upstream detail text' } }),
    { status: 429, headers: { 'Content-Type': 'application/json', ...headers } }
  );
}

function makeClient(token: string | (() => Promise<string>) = 'tok'): { client: YnabClient; limiter: RateLimiter } {
  const limiter = new RateLimiter(180, () => clock.t);
  return { client: new YnabClient(token, 'b1', limiter, new Cache(300000), false, new AuditLog()), limiter };
}

const category = {
  category: { name: 'Gym', category_group_id: 'g1', goal_target: 10000, goal_frequency: 'monthly' as const },
};

beforeEach(() => {
  clock.t = 5_000_000;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('YnabClient 429 handling', () => {
  it.each([
    ['fixed token', 'tok'],
    ['token function', async () => 'tok'],
  ])('SDK path (%s): marks the limiter exhausted using Retry-After and maps the error', async (_n, token) => {
    fetchMock.mockImplementation(async () => tooMany({ 'Retry-After': '120' }));
    const { client, limiter } = makeClient(token);

    const error = await client.getUser().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(YnabApiError);
    const mapped = JSON.parse(formatErrorResponse(error));
    expect(mapped).toMatchObject({ type: 'ynab_api_error', code: '429', message: 'Too many requests', retry_after_seconds: 120 });
    expect(JSON.stringify(mapped)).not.toContain('upstream detail');
    expect(limiter.getStatus().ynabExhausted).toMatchObject({ active: true, exhaustedAtMs: clock.t, retryAfterMs: 120_000 });
  });

  it('fails later calls fast with no request until the window passes, then resumes', async () => {
    fetchMock.mockImplementationOnce(async () => tooMany({ 'Retry-After': '60' }));
    const { client } = makeClient();
    await client.getUser().catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.t += 15_000;
    const blocked = await client.getUser().catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(RateLimitError);
    expect(JSON.parse(formatErrorResponse(blocked))).toMatchObject({
      type: 'rate_limit',
      retry_after_ms: 45_000,
      retry_after_seconds: 45,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock.t += 45_000;
    fetchMock.mockImplementationOnce(async () => ok({ data: { user: { id: 'u1' } } }));
    await expect(client.getUser()).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('without Retry-After uses the oldest request in the rolling hour', async () => {
    fetchMock.mockImplementation(async () => ok({ data: { user: { id: 'u1' } } }));
    const { client, limiter } = makeClient();
    await client.getUser(); // sent at t0
    clock.t += 40 * 60_000;
    fetchMock.mockImplementationOnce(async () => tooMany());

    const error = await client.getUser().catch((e: unknown) => e);

    expect((error as YnabApiError).retryAfterSeconds).toBe(20 * 60);
    expect(limiter.getStatus().ynabExhausted?.retryAfterMs).toBe(20 * 60_000);
  });

  it('direct-fetch (goal_frequency) path handles 429 the same way', async () => {
    fetchMock.mockImplementation(async () => tooMany({ 'Retry-After': '30' }));
    const { client, limiter } = makeClient();

    const error = await client.createCategory('b1', category).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(YnabApiError);
    expect(JSON.parse(formatErrorResponse(error))).toMatchObject({ code: '429', retry_after_seconds: 30 });
    expect(limiter.getStatus().ynabExhausted?.active).toBe(true);
    const next = await client.getUser().catch((e: unknown) => e);
    expect(next).toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not mark the limiter for other errors', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: { id: '404', name: 'not_found', detail: 'x' } }), { status: 404 })
    );
    const { client, limiter } = makeClient();
    await client.getUser().catch(() => undefined);
    expect(limiter.getStatus().ynabExhausted).toBeUndefined();
  });

  it('is per limiter: another user is unaffected', async () => {
    fetchMock.mockImplementationOnce(async () => tooMany({ 'Retry-After': '60' }));
    const a = makeClient();
    const b = makeClient();
    await a.client.getUser().catch(() => undefined);
    fetchMock.mockImplementationOnce(async () => ok({ data: { user: { id: 'u2' } } }));
    await expect(b.client.getUser()).resolves.toBeDefined();
  });
});
