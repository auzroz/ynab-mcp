/**
 * Outbound timeouts (#58): every call to YNAB has a deadline, the body is read
 * inside it, the request's deadline caps it, a write that times out reports an
 * unknown outcome and is never retried, and the mapped error carries no upstream
 * text. fetch is a stub that honours its abort signal; timeouts are shortened to
 * a few tens of milliseconds, never real YNAB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { CircuitBreaker } from '../../../src/services/circuit-breaker.js';
import { OUTBOUND_TIMEOUT_MS, outboundFetch } from '../../../src/services/outbound.js';
import {
  CircuitOpenError,
  OutboundTimeoutError,
  formatErrorResponse,
} from '../../../src/utils/errors.js';

const fetchMock = vi.fn<typeof fetch>();
const SHORT = 40;

/** A fetch that never answers until its signal aborts. */
function stalled(): typeof fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
}

/** A response whose headers arrive at once and whose body never completes. */
function slowDrip(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeClient(
  opts: ConstructorParameters<typeof YnabClient>[8] = {},
  limiter = new RateLimiter(180),
  readOnly = false
): YnabClient {
  return new YnabClient('token', 'b1', limiter, new Cache(300000), readOnly, new AuditLog(), undefined, undefined, {
    outboundTimeoutMs: SHORT,
    ...opts,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('outbound timeout', () => {
  it('defaults to 10 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(async () => ok({}));
    await outboundFetch('https://x.test/a');
    expect(OUTBOUND_TIMEOUT_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it('aborts a stalled response with a fixed OutboundTimeoutError', async () => {
    fetchMock.mockImplementation(stalled());
    const error = await makeClient({}, undefined, true).getUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboundTimeoutError);
    expect((error as OutboundTimeoutError).outcomeUnknown).toBe(false);
    expect((error as Error).message).toBe('YNAB did not respond in time');
  });

  it('cuts off a body that drips in after the headers', async () => {
    fetchMock.mockImplementation(async (_input, init) => slowDrip(init?.signal));
    await expect(makeClient().getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
  });

  it('covers every kind of read through the SDK', async () => {
    fetchMock.mockImplementation(stalled());
    const client = makeClient();
    for (const call of [
      () => client.getUser(),
      () => client.getBudgets(),
      () => client.getAccounts('b1'),
      () => client.getBudgetMonth('b1', '2026-01-01'),
      () => client.getPayeeLocations('b1'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(OutboundTimeoutError);
    }
  });

  it('reports an unknown outcome for a write, and never retries it', async () => {
    fetchMock.mockImplementation(stalled());
    const client = makeClient();
    const error = await client
      .createCategory('b1', { category: { name: 'X', category_group_id: 'g-1' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboundTimeoutError);
    expect((error as OutboundTimeoutError).outcomeUnknown).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mapped = JSON.parse(formatErrorResponse(error)) as Record<string, unknown>;
    expect(mapped).toMatchObject({ error: true, type: 'upstream_timeout', outcome: 'unknown' });
    expect(String(mapped['message'])).toContain('may still have been applied');
  });

  it('maps a read timeout without an unknown outcome and without upstream text', () => {
    const mapped = JSON.parse(formatErrorResponse(new OutboundTimeoutError(false))) as Record<string, unknown>;
    expect(mapped).toEqual({
      error: true,
      type: 'upstream_timeout',
      message: 'YNAB did not respond in time',
      suggestion: 'Try again shortly.',
    });
  });

  it('is not retried after a timeout: one fetch per call', async () => {
    fetchMock.mockImplementation(stalled());
    await expect(makeClient().getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the SDK error mapping for ordinary responses', async () => {
    fetchMock.mockImplementation(async () => ok({ data: { user: { id: 'u1' } } }));
    const response = await makeClient().getUser();
    expect(response.data.user.id).toBe('u1');
  });

  it('honours a caller signal and passes its abort through unchanged', async () => {
    fetchMock.mockImplementation(stalled());
    const controller = new AbortController();
    const pending = outboundFetch('https://x.test/a', { signal: controller.signal }, { timeoutMs: 5000 });
    controller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow('caller gave up');
  });
});

describe('request deadline', () => {
  it('caps the call at the request deadline when that is sooner than the timeout', async () => {
    fetchMock.mockImplementation(stalled());
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const started = Date.now();
    const client = makeClient({ outboundTimeoutMs: 5000, deadline: started + SHORT });
    await expect(client.getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(SHORT);
  });

  it('does not send a call that would start past the deadline, and gives the token back', async () => {
    fetchMock.mockImplementation(async () => ok({}));
    const limiter = new RateLimiter(10);
    const client = makeClient({ deadline: Date.now() - 1 }, limiter);
    await expect(client.getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limiter.getStatus().available).toBe(10);
  });

  it('does not count a deadline-shortened timeout against the breaker', async () => {
    fetchMock.mockImplementation(stalled());
    const breaker = new CircuitBreaker({ threshold: 1 });
    const client = makeClient({ outboundTimeoutMs: 5000, deadline: Date.now() + SHORT, breaker });
    await expect(client.getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(breaker.state()).toBe('closed');
  });
});

describe('circuit breaker wiring', () => {
  it('counts timeouts and 5xx responses, then fails fast without sending', async () => {
    const breaker = new CircuitBreaker({ threshold: 3 });
    const limiter = new RateLimiter(100);
    const client = makeClient({ breaker }, limiter);
    fetchMock.mockImplementation(stalled());
    await expect(client.getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
    fetchMock.mockImplementation(async () => new Response('bad', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
    await expect(client.getUser()).rejects.toThrow();
    await expect(client.getBudgets()).rejects.toThrow();
    expect(breaker.state()).toBe('open');

    fetchMock.mockClear();
    const before = limiter.getStatus().available;
    const error = await client.getUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).not.toHaveBeenCalled();
    // The refused call did not spend rate limit.
    expect(limiter.getStatus().available).toBe(before);
    const mapped = JSON.parse(formatErrorResponse(error)) as Record<string, unknown>;
    expect(mapped).toMatchObject({ type: 'upstream_unavailable', message: 'YNAB is not responding; requests are paused briefly' });
    expect(Number(mapped['retry_after_seconds'])).toBeGreaterThanOrEqual(1);
  });

  it('a 4xx or 429 answer resets the streak', async () => {
    const breaker = new CircuitBreaker({ threshold: 2 });
    const client = makeClient({ breaker });
    fetchMock.mockImplementation(async () => new Response('x', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
    await expect(client.getUser()).rejects.toThrow();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { id: '404', name: 'n', detail: 'd' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    await expect(client.getUser()).rejects.toThrow();
    fetchMock.mockImplementation(async () => new Response('x', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
    await expect(client.getUser()).rejects.toThrow();
    expect(breaker.state()).toBe('closed');
  });
});

describe('per-request wiring', () => {
  it('buildYnabClient hands the request deadline and the user breaker to the client', async () => {
    const { buildYnabClient } = await import('../../../src/server.js');
    const { createUserComponents } = await import('../../../src/services/user-registry.js');
    const user = { accessToken: 'tok', defaultBudgetId: undefined, readOnly: true, rateLimitPerHour: 100, cacheTtlMs: 60_000 };
    const components = createUserComponents(user);
    fetchMock.mockImplementation(async () => new Response('x', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
    const client = buildYnabClient(user, components, Date.now() + 5000);
    await expect(client.getUser()).rejects.toThrow();
    expect(components.breaker.status().consecutiveFailures).toBe(1);

    const late = buildYnabClient(user, components, Date.now() - 1);
    fetchMock.mockClear();
    await expect(late.getUser()).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
