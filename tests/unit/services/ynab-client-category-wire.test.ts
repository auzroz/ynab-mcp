/**
 * Category write payloads as the real ynab SDK (5.x) serializes them, with fetch
 * stubbed: goal_frequency is sent by the SDK itself, and null clears a target.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';

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
