/**
 * Header-mode sessions over HTTP:
 *  - all sessions of one YNAB token share one rate limiter / cache / audit log
 *    (also across a reconnect), and two tokens never share them;
 *  - a session can only be driven with the YNAB token that initialized it.
 * createServerForUser is spied on to see the components each session got.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('../../src/server.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/server.js')>('../../src/server.js');
  return { ...actual, createServerForUser: vi.fn(actual.createServerForUser) };
});

import { createHttpApp } from '../../src/http.js';
import * as serverModule from '../../src/server.js';
import { UserRegistry, type UserComponents, type UserLease } from '../../src/services/user-registry.js';
import { makeHttpConfig } from './helpers/http-config.js';

const createServerMock = vi.mocked(serverModule.createServerForUser);

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};
const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

function mcp(app: Express, method: 'post' | 'get' | 'delete', token?: string, sessionId?: string): request.Test {
  let req = request(app)[method]('/mcp').set('Accept', 'application/json, text/event-stream');
  if (token !== undefined) req = req.set('X-YNAB-Token', token);
  if (sessionId !== undefined) req = req.set('mcp-session-id', sessionId);
  return req;
}

/** Initialize a session; returns its id and the components it was built on. */
async function initSession(app: Express, token?: string): Promise<{ sid: string; components: UserComponents }> {
  const res = await mcp(app, 'post', token).send(initializeBody);
  expect(res.status).toBe(200);
  const sid = res.headers['mcp-session-id'] as string | undefined;
  const components = createServerMock.mock.calls.at(-1)?.[1];
  if (!sid || !components) throw new Error('no session');
  return { sid, components };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('per-user state in header mode', () => {
  it("shares one limiter, cache and audit log across a token's sessions", async () => {
    const app = await createHttpApp(makeHttpConfig());
    const a = await initSession(app, 'token-a');
    const b = await initSession(app, 'token-a');
    expect(b.sid).not.toBe(a.sid);
    expect(b.components.rateLimiter).toBe(a.components.rateLimiter);
    expect(b.components.cache).toBe(a.components.cache);
    expect(b.components.auditLog).toBe(a.components.auditLog);
  });

  it('gives two tokens separate limiters, caches and audit logs', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const a = await initSession(app, 'token-a');
    const b = await initSession(app, 'token-b');
    expect(b.components.rateLimiter).not.toBe(a.components.rateLimiter);
    expect(b.components.cache).not.toBe(a.components.cache);
    expect(b.components.auditLog).not.toBe(a.components.auditLog);
  });

  it('keeps the rate limiter across a reconnect (closing the session does not reset it)', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const first = await initSession(app, 'token-a');
    await first.components.rateLimiter.acquire();
    const del = await mcp(app, 'delete', 'token-a', first.sid);
    expect(del.status).toBe(200);

    const again = await initSession(app, 'token-a');
    expect(again.components.rateLimiter).toBe(first.components.rateLimiter);
    expect(again.components.rateLimiter.getStatus().used).toBe(1);
  });
});

describe('session holds on the user registry', () => {
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

  it('releases the hold when the session is deleted', async () => {
    const leases = trackLeases();
    const app = await createHttpApp(makeHttpConfig());
    const { sid } = await initSession(app, 'token-a');
    expect(leases.releases()).toEqual([0]);
    await mcp(app, 'delete', 'token-a', sid);
    expect(leases.releases()).toEqual([1]);
  });

  it('releases the hold of an initialize the transport refuses', async () => {
    const leases = trackLeases();
    const app = await createHttpApp(makeHttpConfig());
    // No Accept header: the transport answers 406 and never creates a session.
    const res = await request(app).post('/mcp').set('X-YNAB-Token', 'token-a').send(initializeBody);
    expect(res.status).toBe(406);
    expect(leases.releases()).toEqual([1]);
  });
});

describe('header-mode sessions are bound to their YNAB token', () => {
  it('a different token cannot use, stream from, or delete a session', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sid } = await initSession(app, 'token-a');

    const post = await mcp(app, 'post', 'token-b', sid).send(toolsList);
    expect(post.status).toBe(400);
    expect(post.body.error.message).toBe('Bad Request: no valid session for this request');
    expect(JSON.stringify(post.body)).not.toContain('ynab_');
    const unknown = await mcp(app, 'post', 'token-b', 'no-such-session').send(toolsList);
    expect(unknown.status).toBe(post.status);
    expect(unknown.body).toEqual(post.body);

    const get = await mcp(app, 'get', 'token-b', sid);
    expect(get.status).toBe(400);
    expect(get.body.error.message).toBe('Bad Request: unknown or missing session id');
    const del = await mcp(app, 'delete', 'token-b', sid);
    expect(del.status).toBe(400);

    // No token at all is refused the same way.
    const anonymous = await mcp(app, 'post', undefined, sid).send(toolsList);
    expect(anonymous.status).toBe(400);
    expect(anonymous.body).toEqual(post.body);

    // The owner's session survived the attempts.
    const own = await mcp(app, 'post', 'token-a', sid).send(toolsList);
    expect(own.status).toBe(200);
    expect(own.text).toContain('ynab_');

    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('[Session] rejected');
    expect(logged).not.toContain(sid);
    expect(logged).not.toContain('token-a');
    expect(logged).not.toContain('token-b');
    errorSpy.mockRestore();
  });

  it('a session opened with the fallback token is bound to it, not to whoever omits the header', async () => {
    const app = await createHttpApp(makeHttpConfig({ fallbackAccessToken: 'env-token' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sid } = await initSession(app);

    const other = await mcp(app, 'post', 'token-b', sid).send(toolsList);
    expect(other.status).toBe(400);
    // Presenting the fallback token explicitly is the same effective token.
    const explicit = await mcp(app, 'post', 'env-token', sid).send(toolsList);
    expect(explicit.status).toBe(200);
    const implicit = await mcp(app, 'post', undefined, sid).send(toolsList);
    expect(implicit.status).toBe(200);
    vi.mocked(console.error).mockRestore();
  });
});
