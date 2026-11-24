/**
 * Per-client attribution of a user's YNAB requests (#58): the ClientUsage
 * record, and how YnabClient feeds it (single calls, fan-out reservations,
 * refusals and tokens given back).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientUsage } from '../../../src/services/client-usage.js';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';

const HOUR = 3_600_000;

describe('ClientUsage', () => {
  it('counts sent and refused calls per client over the last hour', () => {
    let t = 1_000_000;
    const usage = new ClientUsage(() => t);
    usage.sent('a');
    usage.sent('a');
    usage.sent('b');
    usage.rejected('a');
    usage.unsent('a');
    expect(usage.status('a')).toEqual({ sentLastHour: 1, rejectedLastHour: 1 });
    expect(usage.status('b')).toEqual({ sentLastHour: 1, rejectedLastHour: 0 });
    expect(usage.status('nobody')).toEqual({ sentLastHour: 0, rejectedLastHour: 0 });
    t += HOUR;
    expect(usage.status('a')).toEqual({ sentLastHour: 0, rejectedLastHour: 0 });
  });

  it('keeps at most maxClients, dropping the least recently active', () => {
    const usage = new ClientUsage(Date.now, 2);
    usage.sent('a');
    usage.sent('b');
    usage.sent('a'); // a is now the most recent
    usage.sent('c');
    expect(usage.size).toBe(2);
    expect(usage.status('b').sentLastHour).toBe(0);
    expect(usage.status('a').sentLastHour).toBe(2);
    expect(usage.status('c').sentLastHour).toBe(1);
  });
});

describe('YnabClient per-client usage', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { user: { id: 'u1' } } }), {
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

  function clientFor(limiter: RateLimiter, usage: ClientUsage, clientId: string | undefined): YnabClient {
    return new YnabClient('token', 'b1', limiter, new Cache(300000), true, new AuditLog(), undefined, undefined, {
      clientId,
      clientUsage: usage,
    });
  }

  it("attributes each request to its client, on one user's shared limiter", async () => {
    const limiter = new RateLimiter(10, Date.now, 0);
    const usage = new ClientUsage();
    const a = clientFor(limiter, usage, 'client-a');
    const b = clientFor(limiter, usage, 'client-b');
    await a.getUser();
    await a.getUser();
    await b.getUser();
    expect(a.getClientUsage()).toEqual({ clientId: 'client-a', sentLastHour: 2, rejectedLastHour: 0 });
    expect(b.getClientUsage()).toEqual({ clientId: 'client-b', sentLastHour: 1, rejectedLastHour: 0 });
    expect(a.getRateLimitStatus().sentLastHour).toBe(3);
  });

  it('counts a fan-out by the requests it sent, not its reservation, and refusals per client', async () => {
    const limiter = new RateLimiter(5, Date.now, 0);
    const usage = new ClientUsage();
    const a = clientFor(limiter, usage, 'client-a');
    const b = clientFor(limiter, usage, 'client-b');
    await a.withFanOut(4, async () => {
      await a.getUser();
    });
    expect(a.getClientUsage()).toMatchObject({ sentLastHour: 1 });
    // a uses up the bucket; b's call and b's fan-out are refused, and counted for b.
    for (let i = 0; i < 4; i++) await a.getUser();
    await expect(b.getUser()).rejects.toThrow();
    await expect(b.withFanOut(3, async () => b.getUser())).rejects.toThrow();
    expect(b.getClientUsage()).toEqual({ clientId: 'client-b', sentLastHour: 0, rejectedLastHour: 2 });
    expect(a.getClientUsage()).toEqual({ clientId: 'client-a', sentLastHour: 5, rejectedLastHour: 0 });
  });

  it('takes back a request that was never sent (its access token could not be resolved)', async () => {
    const limiter = new RateLimiter(10);
    const usage = new ClientUsage();
    const failing = new YnabClient(
      () => Promise.reject(new Error('no token')),
      'b1',
      limiter,
      new Cache(300000),
      true,
      new AuditLog(),
      undefined,
      undefined,
      { clientId: 'client-a', clientUsage: usage }
    );
    await expect(failing.getUser()).rejects.toThrow();
    expect(failing.getClientUsage()).toEqual({ clientId: 'client-a', sentLastHour: 0, rejectedLastHour: 0 });
    expect(limiter.getStatus().sentLastHour).toBe(0);
  });

  it('reports no client id without one (stdio, header mode), and nothing when untracked', async () => {
    const usage = new ClientUsage();
    const local = clientFor(new RateLimiter(10), usage, undefined);
    await local.getUser();
    expect(local.getClientUsage()).toEqual({ clientId: undefined, sentLastHour: 1, rejectedLastHour: 0 });
    const untracked = new YnabClient('token', 'b1', new RateLimiter(10), new Cache(300000), true, new AuditLog());
    expect(untracked.getClientUsage()).toBeUndefined();
  });
});
