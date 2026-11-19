/**
 * Header-mode requests over stateless HTTP (ADR-0001):
 *  - all requests of one YNAB token share one rate limiter / cache / audit log
 *    (also between requests), and two tokens never share them;
 *  - each request holds a registry lease while it runs, released when done;
 *  - a request is served as the YNAB token it carries, whatever else it sends.
 * createServerForRequest is spied on to see the context each request got.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../../src/server.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/server.js')>('../../src/server.js');
  return { ...actual, createServerForRequest: vi.fn(actual.createServerForRequest) };
});

import { createHttpApp } from '../../src/http.js';
import * as serverModule from '../../src/server.js';
import { UserRegistry, type UserLease } from '../../src/services/user-registry.js';
import type { RequestContext } from '../../src/server.js';
import { makeHttpConfig } from './helpers/http-config.js';

const createServerMock = vi.mocked(serverModule.createServerForRequest);

const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

function mcp(app: Express, token?: string, sessionId?: string): request.Test {
  let req = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (token !== undefined) req = req.set('X-YNAB-Token', token);
  if (sessionId !== undefined) req = req.set('mcp-session-id', sessionId);
  return req;
}

/** Send one request; returns the context its server was built from. */
async function served(app: Express, token?: string, sessionId?: string): Promise<RequestContext> {
  const res = await mcp(app, token, sessionId).send(toolsList);
  expect(res.status).toBe(200);
  const ctx = createServerMock.mock.calls.at(-1)?.[0];
  if (!ctx) throw new Error('no server built');
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('per-user state in header mode', () => {
  it("shares one limiter, cache and audit log across a token's requests", async () => {
    const app = await createHttpApp(makeHttpConfig());
    const a = (await served(app, 'token-a')).components;
    const b = (await served(app, 'token-a')).components;
    expect(b.rateLimiter).toBe(a.rateLimiter);
    expect(b.cache).toBe(a.cache);
    expect(b.auditLog).toBe(a.auditLog);
    expect(b.feedState).toBe(a.feedState);
  });

  it('gives two tokens separate limiters, caches and audit logs', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const a = (await served(app, 'token-a')).components;
    const b = (await served(app, 'token-b')).components;
    expect(b.rateLimiter).not.toBe(a.rateLimiter);
    expect(b.cache).not.toBe(a.cache);
    expect(b.auditLog).not.toBe(a.auditLog);
  });

  it('keeps the rate limiter between requests (a finished request does not reset it)', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const first = (await served(app, 'token-a')).components;
    await first.rateLimiter.acquire();

    const again = (await served(app, 'token-a')).components;
    expect(again.rateLimiter).toBe(first.rateLimiter);
    expect(again.rateLimiter.getStatus().used).toBe(1);
  });
});

describe('request holds on the user registry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spy on every lease the app takes, counting its releases. */
  function trackLeases(): { releases: () => number[] } {
    const counts: number[] = [];
    const acquire = UserRegistry.prototype.acquire;
    vi.spyOn(UserRegistry.prototype, 'acquire').mockImplementation(function (this: UserRegistry, key: string) {
      const lease: UserLease = acquire.call(this, key);
      const i = counts.push(0) - 1;
      return {
        components: lease.components,
        release: () => {
          counts[i] = (counts[i] ?? 0) + 1;
          lease.release();
        },
      };
    });
    return { releases: () => [...counts] };
  }

  it('releases the hold when the request is done', async () => {
    const leases = trackLeases();
    const app = await createHttpApp(makeHttpConfig());
    await served(app, 'token-a');
    await served(app, 'token-a');
    // One lease per request, each released once.
    expect(leases.releases()).toEqual([1, 1]);
  });

  it('releases the hold of a request the transport refuses', async () => {
    const leases = trackLeases();
    const app = await createHttpApp(makeHttpConfig());
    // No Accept header: the SDK's transport answers 406.
    const res = await request(app).post('/mcp').set('X-YNAB-Token', 'token-a').send(toolsList);
    expect(res.status).toBe(406);
    expect(leases.releases()).toEqual([1]);
  });
});

describe('header-mode requests are served as the YNAB token they carry', () => {
  it("a different token gets its own state, even with another token's 0.4 session id", async () => {
    const app = await createHttpApp(makeHttpConfig());
    const a = await served(app, 'token-a');
    const b = await served(app, 'token-b', 'a-session-id-from-token-a');
    expect(b.userKey).not.toBe(a.userKey);
    expect(b.components.auditLog).not.toBe(a.components.auditLog);
    expect(b.user.accessToken).toBe('token-b');

    // No token at all is refused, session id or not.
    const anonymous = await mcp(app, undefined, 'a-session-id-from-token-a').send(toolsList);
    expect(anonymous.status).toBe(401);
    expect(anonymous.text).not.toContain('ynab_');
  });

  it('a request without the header acts as the fallback token, one with a header as that token', async () => {
    const app = await createHttpApp(makeHttpConfig({ fallbackAccessToken: 'env-token' }));
    const implicit = await served(app);
    const explicit = await served(app, 'env-token');
    const other = await served(app, 'token-b');
    // Presenting the fallback token explicitly is the same effective token.
    expect(explicit.userKey).toBe(implicit.userKey);
    expect(implicit.user.accessToken).toBe('env-token');
    expect(other.userKey).not.toBe(implicit.userKey);
  });

  it('keys state by a digest: the YNAB token is not the registry key or in the request identity', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const ctx = await served(app, 'token-a');
    expect(ctx.userKey).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.userKey).not.toContain('token-a');
    expect(ctx.clientId).toBeUndefined();
  });
});
