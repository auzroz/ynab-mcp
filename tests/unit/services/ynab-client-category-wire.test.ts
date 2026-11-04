/**
 * Category write payloads as the real ynab SDK (5.x) serializes them, with fetch
 * stubbed: goal_frequency is sent by the SDK itself, and null clears a target.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { YnabApiError } from '../../../src/utils/errors.js';

const fetchMock = vi.fn<typeof fetch>();
const BUDGET = 'budget-1';

function makeClient(): YnabClient {
  return new YnabClient('token', BUDGET, new RateLimiter(180), new Cache(300000), false, new AuditLog());
}

function request(n = 0): { url: string; method: string | undefined; body: any } {
  const [url, init] = fetchMock.mock.calls[n]!;
  return { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ data: { category: { id: 'cat-1' }, server_knowledge: 5 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('category write payloads through the ynab SDK', () => {
  it('createCategory sends goal_frequency with the target', async () => {
    await makeClient().createCategory(BUDGET, {
      category: { name: 'Dining Out', category_group_id: 'g-1', goal_target: 50000, goal_frequency: 'weekly' },
    });
    const req = request();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/categories');
    expect(req.body.category).toMatchObject({ goal_target: 50000, goal_frequency: 'weekly' });
  });

  it('updateCategory sends goal_frequency on PATCH', async () => {
    await makeClient().updateCategory(BUDGET, 'cat-1', {
      category: { goal_target: 20000, goal_frequency: 'yearly' },
    });
    const req = request();
    expect(req.method).toBe('PATCH');
    expect(req.url).toContain('/categories/cat-1');
    expect(req.body.category).toMatchObject({ goal_target: 20000, goal_frequency: 'yearly' });
  });

  it('updateCategory sends goal_target: null to remove a target', async () => {
    await makeClient().updateCategory(BUDGET, 'cat-1', { category: { goal_target: null } });
    expect(request().body.category).toEqual({ goal_target: null });
  });

  it('updateCategory sends note: null to clear a note', async () => {
    await makeClient().updateCategory(BUDGET, 'cat-1', { category: { note: null } });
    expect(request().body.category).toEqual({ note: null });
  });
});

describe('category write deadline', () => {
  it.each([
    ['createCategory', (c: YnabClient) => c.createCategory(BUDGET, { category: { name: 'X', category_group_id: 'g-1' } })],
    ['updateCategory', (c: YnabClient) => c.updateCategory(BUDGET, 'cat-1', { category: { name: 'X' } })],
  ])('%s passes an abort signal to fetch', async (_name, call) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await call(makeClient());
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(init?.signal).toBe(timeout.mock.results[0]?.value);
  });
});

describe('non-JSON error responses', () => {
  it.each([
    ['createCategory', (c: YnabClient) => c.createCategory(BUDGET, { category: { name: 'X', category_group_id: 'g-1' } })],
    ['updateCategory', (c: YnabClient) => c.updateCategory(BUDGET, 'cat-1', { category: { name: 'X' } })],
  ])('%s maps a 502 HTML page by status, without its text', async (_name, call) => {
    fetchMock.mockImplementation(
      async () =>
        new Response('<html>upstream-secret-fragment</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    const error = await call(makeClient()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(YnabApiError);
    expect((error as YnabApiError).code).toBe('502');
    expect(String((error as Error).message)).not.toContain('upstream-secret-fragment');
  });

  it('still lets the SDK parse a JSON error body', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { id: '404.2', name: 'resource_not_found', detail: 'Not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
    );
    await expect(makeClient().updateCategory(BUDGET, 'cat-1', { category: { name: 'X' } })).rejects.toMatchObject({
      error: { id: '404.2' },
    });
  });
});
