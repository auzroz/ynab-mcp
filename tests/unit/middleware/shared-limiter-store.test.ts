/**
 * #67: the shared limiters fail closed whatever the store throws, without a
 * database (a store that always fails stands in for one that is down). Every
 * AS limiter answers its usual 429 with Retry-After 5; the /register host
 * limit refuses; the metadata-document budget refuses the fetch; the per-user
 * YNAB limiter throws RateLimitStoreUnavailableError, which a tool call
 * reports as upstream_unavailable; and nothing is ever let through on a
 * budget of the process's own.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Options } from 'express-rate-limit';
import { keyedLimiter, registerHostLimiter } from '../../../src/middleware/rate-limiters.js';
import { SharedWindowStore, sharedLimiterStores } from '../../../src/middleware/shared-limiter-store.js';
import { SharedLimitUnavailableError, type SharedLimitStore } from '../../../src/storage/shared-limits.js';
import { SharedRateLimiter } from '../../../src/services/shared-rate-limiter.js';
import { SharedWriteLimiter } from '../../../src/services/shared-write-limiter.js';
import { createClientIdMetadataDocuments } from '../../../src/auth/client-id-metadata.js';
import { formatErrorResponse, RateLimitStoreUnavailableError } from '../../../src/utils/errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A store whose every call fails, as PostgresSharedLimits does when the database is down. */
function downStore(): SharedLimitStore & { calls: string[] } {
  const calls: string[] = [];
  const fail = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new SharedLimitUnavailableError();
  };
  return {
    calls,
    hit: fail('hit'),
    unhit: fail('unhit'),
    resetHits: fail('resetHits'),
    getHits: fail('getHits'),
    take: fail('take'),
    give: fail('give'),
    block: fail('block'),
    peek: fail('peek'),
    admitWrite: fail('admitWrite'),
    releaseWrite: fail('releaseWrite'),
  };
}

const key = { trustCfConnectingIp: false };

describe('the AS limiters with the shared store down', () => {
  it('a keyed limiter answers its 429 with Retry-After 5 and never calls the route', async () => {
    const store = downStore();
    const route = vi.fn((_req: express.Request, res: express.Response) => res.sendStatus(200));
    const app = express();
    app.post('/token', ...keyedLimiter({ name: 'route:token', windowMs: 900_000, limit: 50, message: { error: 'limited' }, key, store: sharedLimiterStores(store) }), route);
    const res = await request(app).post('/token');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'limited' });
    expect(res.headers['retry-after']).toBe('5');
    expect(route).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['hit']);
  });

  it('the /register host limit refuses the registration', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/register',
      registerHostLimiter({
        windowMs: 3_600_000,
        perIp: 100,
        perHost: 20,
        message: { error: 'limited' },
        tooManyRedirects: { error: 'invalid_client_metadata' },
        key,
        store: sharedLimiterStores(downStore()),
      }),
      (_req, res) => res.sendStatus(201)
    );
    const res = await request(app).post('/register').send({ redirect_uris: ['https://client.example/cb'] });
    expect(res.status).toBe(429);
  });

  it('decrement swallows the failure (it only ever counts against the caller); get and resetKey report it', async () => {
    const store = new SharedWindowStore(downStore(), 'x');
    store.init({ windowMs: 1_000 } as Options);
    await expect(store.decrement('k')).resolves.toBeUndefined();
    await expect(store.get('k')).rejects.toBeInstanceOf(SharedLimitUnavailableError);
    await expect(store.resetKey('k')).rejects.toBeInstanceOf(SharedLimitUnavailableError);
    expect(store.localKeys).toBe(false);
    expect(store.prefix).toBe('x:');
  });

  it('the metadata-document fetch budget refuses the fetch', async () => {
    const hooks = createClientIdMetadataDocuments({
      policy: { privateUseSchemes: [] },
      keyOptions: key,
      limiterStore: sharedLimiterStores(downStore()),
    });
    expect(await hooks.feature.allowFetch(undefined, 'https://client.example/c.json')).toBe(false);
  });
});

describe('the per-user YNAB limiter with the shared store down', () => {
  it('refuses every acquire with RateLimitStoreUnavailableError, never from a local budget', async () => {
    const store = downStore();
    const limiter = new SharedRateLimiter(store, 'u1', 180, Date.now, 2_000);
    for (let i = 0; i < 3; i++) {
      const refused = await limiter.acquire().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RateLimitStoreUnavailableError);
      expect((refused as RateLimitStoreUnavailableError).retryAfterMs).toBe(5_000);
    }
    await expect(limiter.acquireMany(5)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    await expect(limiter.refresh()).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(limiter.getStatus()).toMatchObject({ sentLastHour: 0, store: 'postgres' });
  });

  it('release and the 429 note are sent without waiting, and a failure throws nothing', async () => {
    const store = downStore();
    const limiter = new SharedRateLimiter(store, 'u1', 180);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => limiter.release(2)).not.toThrow();
      expect(limiter.markExhaustedByYnab(30_000)).toBe(30_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.calls).toEqual(['give', 'block']);
      expect(unhandled).not.toHaveBeenCalled();
      // The 429 still applies here at once.
      await expect(limiter.acquire()).rejects.toMatchObject({ name: 'RateLimitError' });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a tool call reports it as upstream_unavailable with retry_after_seconds, nothing sent to YNAB', () => {
    expect(JSON.parse(formatErrorResponse(new RateLimitStoreUnavailableError(5_000)))).toEqual({
      error: true,
      type: 'upstream_unavailable',
      message: 'The rate limit store is temporarily unavailable; nothing was sent to YNAB',
      retry_after_ms: 5_000,
      retry_after_seconds: 5,
      suggestion: 'Try again after the retry time.',
    });
  });

  it('the shared write cap refuses every write with RateLimitStoreUnavailableError; a cap of 0 never asks', async () => {
    const store = downStore();
    const cap = new SharedWriteLimiter(store, 'u1', 20);
    await expect(cap.tryAcquire()).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    await expect(cap.tryAcquire()).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(store.calls).toEqual(['admitWrite', 'admitWrite']);
    expect(await new SharedWriteLimiter(store, 'u1', 0).tryAcquire()).toMatchObject({ allowed: true });
    expect(store.calls).toHaveLength(2);
    expect(() => new SharedWriteLimiter(store, 'u1', -1)).toThrow(/non-negative/);
  });

  it('a booked waiter whose recheck of the shared pause fails gives its token back and refuses (fail closed)', async () => {
    const store = downStore();
    // The take books a token 20 ms out; the recheck after the wait can't reach the store.
    store.take = async () => ({ previousTat: 1_000, tat: 1_000 + 3_600_000 + 20, blockedUntil: 0, now: 1_000 });
    const limiter = new SharedRateLimiter(store, 'u1', 7_200, Date.now, 2_000);
    const refused = await limiter.acquire().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RateLimitStoreUnavailableError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.calls).toEqual(['peek', 'give']);
    expect(limiter.getStatus().sentLastHour).toBe(0);
  });

  it('refuses an invalid count before calling the store', async () => {
    const store = downStore();
    const limiter = new SharedRateLimiter(store, 'u1', 180);
    await expect(limiter.acquireMany(0)).rejects.toThrow(/positive integer/);
    expect(store.calls).toEqual([]);
  });
});
