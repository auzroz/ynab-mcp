/**
 * Gate G2: /mcp is stateless (ADR-0001).
 *
 *  - two users sending the same JSON-RPC id each get their own result;
 *  - no Mcp-Session-Id is issued; GET and DELETE /mcp answer 405;
 *  - a downgraded grant loses write tools on its token's next request (D4);
 *  - the in-flight caps answer 429 with Retry-After: 1 per user, per (client,
 *    user) and per process (D6);
 *  - the request ceiling holds: a stalled tool call returns a timeout result by
 *    the request's deadline (a write's says its outcome is unknown, also on a
 *    2025 SSE stream with keepalives running), a stalled resolver gets the
 *    ceiling's JSON-RPC error (D6, Q8);
 *  - slots and leases are released when the response has closed AND the work
 *    the request started has settled, including after a client disconnects (D5).
 *
 * YNAB is never reached: its API (fetch) and token refresh are mocked, and
 * the stubs below hold calls open on demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, refreshAccessToken: vi.fn() };
});

vi.mock('../../src/prompts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/prompts/index.js')>();
  return { ...actual, getPromptMessages: vi.fn(actual.getPromptMessages) };
});

const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import { buildHttpApp, INFLIGHT_RETRY_AFTER_SEC, startHttpServer, type HttpApp, type HttpAppOptions } from '../../src/http.js';
import * as ynabOauth from '../../src/auth/ynab-oauth.js';
import * as promptsModule from '../../src/prompts/index.js';
import { Encryptor } from '../../src/crypto.js';
import { WRITE_TIMEOUT_MESSAGE, TOOL_TIMEOUT_MESSAGE } from '../../src/server.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import {
  MCP_ACCEPT,
  bearer,
  mcpConnect,
  mcpPost,
  rpcMessageOrUndefined,
  ynabToken,
  type McpAuth,
} from './helpers/mcp-call.js';
import type { HttpConfig } from '../../src/config/environment.js';

const refreshMock = vi.mocked(ynabOauth.refreshAccessToken);
/** The real fetch, for talking to a listening server while YNAB's fetch is stubbed. */
const fetchReal = globalThis.fetch;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait (bounded) until `check` holds. */
async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * The YNAB API as a fetch stub. `hold()` makes every later call wait until
 * `release()`; a call answers ynab_get_user with an id derived from the YNAB
 * token it was sent with ("token-a" -> "user-token-a").
 */
function ynabApi() {
  let held = false;
  const waiting: Array<() => void> = [];
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (held) await new Promise<void>((resolve) => waiting.push(resolve));
    const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
    const body = init?.method === 'POST' ? { data: { category_group: { id: 'g1', name: 'x' } } } : { data: { user: { id: `user-${token}` } } };
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  return {
    fetchMock,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
    get waiting() {
      return waiting.length;
    },
  };
}

let api: ReturnType<typeof ynabApi>;
let handles: HttpApp[] = [];

beforeEach(() => {
  api = ynabApi();
  vi.stubGlobal('fetch', api.fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  refreshMock.mockReset();
  refreshMock.mockImplementation(async () => ({
    accessToken: 'ynab-access',
    refreshToken: `ynab-refresh-${randomBytes(4).toString('hex')}`,
    expiresAt: Date.now() + 7_200_000,
  }));
});

afterEach(async () => {
  api.release();
  for (const h of handles.splice(0)) await h.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function headerApp(overrides: Partial<HttpConfig> = {}, options: HttpAppOptions = {}): Promise<HttpApp> {
  const handle = await buildHttpApp(makeHttpConfig(overrides), options);
  handles.push(handle);
  return handle;
}

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;

/** oauth mode with storage the test can plant users and access tokens in. */
async function oauthApp(overrides: Partial<HttpConfig> = {}): Promise<{
  handle: HttpApp;
  storage: Storage;
  addUser: (userId: string, grantedScope: 'read-only' | 'read-write') => Promise<void>;
  token: (userId: string, clientId: string, level?: 'read-only' | 'read-write') => Promise<string>;
}> {
  const encryptionKey = randomBytes(32).toString('base64');
  const handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      authMode: 'oauth',
      oauthClientId: 'cid',
      oauthClientSecret: 'sec',
      encryptionKey,
      tokenPepper: TEST_TOKEN_PEPPER,
      readOnly: false,
      ...overrides,
    })
  );
  handles.push(handle);
  const storage = created.storage!;
  const encryptor = new Encryptor(encryptionKey);
  return {
    handle,
    storage,
    addUser: async (userId, grantedScope) => {
      await storage.upsertUser({
        userId,
        grantedScope,
        encryptedRefreshToken: encryptor.encrypt(`refresh-${userId}`),
        updatedAt: Date.now(),
      });
    },
    token: async (userId, clientId, level = 'read-write') => {
      const { value, key } = TEST_TOKEN_HASHER.issue('access');
      await storage.saveAccessToken({
        token: key,
        clientId,
        userId,
        scopes: [level],
        expiresAt: Date.now() + 3_600_000,
        resource: RESOURCE,
        grantedScope: level,
      });
      return value;
    },
  };
}

const call = (id: number | string, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** Start a request without waiting for it (supertest only sends once awaited). */
function start(app: Express, auth: McpAuth, body: unknown): Promise<request.Response> {
  return mcpPost(app, auth, body, '2025-06-18').then((r) => r);
}

const toolText = (res: request.Response): string =>
  ((rpcMessageOrUndefined(res)?.['result']?.['content'] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '');

describe('G2: requests stand alone', () => {
  it('two users sending the same JSON-RPC id each get their own result', async () => {
    const { app } = await headerApp();
    api.hold();
    const a = start(app, ynabToken('token-a'), call(7, 'ynab_get_user'));
    const b = start(app, ynabToken('token-b'), call(7, 'ynab_get_user'));
    // Both are in flight at once before either is answered.
    await until(() => api.waiting === 2, 'both YNAB calls');
    api.release();
    const [resA, resB] = await Promise.all([a, b]);
    for (const [res, user] of [
      [resA, 'user-token-a'],
      [resB, 'user-token-b'],
    ] as const) {
      expect(res.status).toBe(200);
      expect(rpcMessageOrUndefined(res)?.['id']).toBe(7);
      expect(toolText(res)).toContain(user);
    }
    expect(toolText(resA)).not.toContain('user-token-b');
    expect(toolText(resB)).not.toContain('user-token-a');
  });

  it('issues no Mcp-Session-Id on initialize, a notification, tools/list or tools/call', async () => {
    const { app } = await headerApp();
    const init = await mcpPost(app, ynabToken('token-a'), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.status).toBe(200);
    const responses = [
      init,
      await mcpPost(app, ynabToken('token-a'), { jsonrpc: '2.0', method: 'notifications/initialized' }, '2025-06-18'),
      await mcpPost(app, ynabToken('token-a'), { jsonrpc: '2.0', id: 2, method: 'tools/list' }, '2025-06-18'),
      await mcpPost(app, ynabToken('token-a'), call(3, 'ynab_rate_limit_status'), '2025-06-18'),
    ];
    for (const res of responses) {
      expect(res.status).toBeLessThan(300);
      expect(res.headers['mcp-session-id']).toBeUndefined();
    }
  });

  it('serves a request without any initialize, and ignores a session id sent anyway', async () => {
    const { app } = await headerApp();
    const res = await request(app)
      .post('/mcp')
      .set(ynabToken('token-a'))
      .set('Accept', MCP_ACCEPT)
      .set('Mcp-Session-Id', 'left-over-from-0.4')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(rpcMessageOrUndefined(res)?.['result']?.['tools'].length).toBeGreaterThan(0);
  });

  it.each(['get', 'delete'] as const)('%s /mcp answers 405 from the SDK, in header mode', async (method) => {
    const { app } = await headerApp();
    const res = await request(app)[method]('/mcp').set(ynabToken('token-a')).set('Accept', MCP_ACCEPT);
    expect(res.status).toBe(405);
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  it.each(['get', 'delete'] as const)('%s /mcp answers 405 after the bearer check, in oauth mode', async (method) => {
    const { addUser, token, handle } = await oauthApp();
    await addUser('u1', 'read-write');
    const access = await token('u1', 'client-a');
    const res = await request(handle.app)[method]('/mcp').set(bearer(access)).set('Accept', MCP_ACCEPT);
    expect(res.status).toBe(405);
    // Unauthenticated, the bearer stage answers first.
    expect((await request(handle.app)[method]('/mcp')).status).toBe(401);
  });

  it('serves only exactly /mcp: a path under it is not the MCP endpoint', async () => {
    const { app } = await headerApp();
    const res = await mcpPost(app, ynabToken('token-a'), { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(200);
    const under = await request(app).post('/mcp/extra').set(ynabToken('token-a')).set('Accept', MCP_ACCEPT).send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(under.status).toBe(404);
  });
});

describe('G2: read-only is computed on every request (D4)', () => {
  const writeTool = 'ynab_create_category_group';

  it("a downgraded grant loses write tools on its token's next request", async () => {
    const { handle, addUser, token } = await oauthApp({ allowWrite: true });
    await addUser('u1', 'read-write');
    const access = await token('u1', 'client-a');
    const mcp = await mcpConnect(handle.app, bearer(access));
    expect(await mcp.listTools()).toContain(writeTool);

    // The user reconnects YNAB read-only; the same MCP token's next request is read-only.
    await addUser('u1', 'read-only');
    expect(await mcp.listTools()).not.toContain(writeTool);
    const write = await mcp.callTool(writeTool, { budget_id: 'last-used', name: 'Nope' });
    expect(write.isError).toBe(true);
    expect(write.text).toContain('read_only_mode');
    expect(api.fetchMock).not.toHaveBeenCalled();

    // And back: an upgrade takes effect on the next request too.
    await addUser('u1', 'read-write');
    expect(await mcp.listTools()).toContain(writeTool);
  });

  it('a read-only token stays read-only on a read-write grant', async () => {
    const { handle, addUser, token } = await oauthApp({ allowWrite: true });
    await addUser('u1', 'read-write');
    const mcp = await mcpConnect(handle.app, bearer(await token('u1', 'client-a', 'read-only')));
    expect(await mcp.listTools()).not.toContain(writeTool);
  });
});

describe('G2: in-flight caps (D6)', () => {
  /** Expect a 429 with Retry-After: 1 and a JSON-RPC error that echoes the id. */
  function expectRefused(res: request.Response, id: number): void {
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe(String(INFLIGHT_RETRY_AFTER_SEC));
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests in flight; retry shortly' },
      id,
    });
  }

  it('answers 429 past the per-user cap, without touching another user, and frees the slots when the work settles', async () => {
    const { app, inflight } = await headerApp({ maxInflightPerUser: 2 });
    api.hold();
    const held = [start(app, ynabToken('token-a'), call(1, 'ynab_get_user')), start(app, ynabToken('token-a'), call(2, 'ynab_get_user'))];
    await until(() => api.waiting === 2, 'two held calls');

    expectRefused(await mcpPost(app, ynabToken('token-a'), call(3, 'ynab_get_user'), '2025-06-18'), 3);
    // Another user is not affected.
    expect((await mcpPost(app, ynabToken('token-b'), { jsonrpc: '2.0', id: 4, method: 'ping' })).status).toBe(200);

    api.release();
    for (const res of await Promise.all(held)) expect(res.status).toBe(200);
    await until(() => inflight.inflight() === 0, 'slots released');
    expect((await mcpPost(app, ynabToken('token-a'), { jsonrpc: '2.0', id: 5, method: 'ping' })).status).toBe(200);
  });

  it('answers 429 past the per-(client, user) cap while the same user on another client still gets through', async () => {
    const { handle, addUser, token } = await oauthApp({ maxInflightPerUser: 3, maxInflightPerClient: 2 });
    await addUser('u1', 'read-write');
    const a = await token('u1', 'client-a');
    const b = await token('u1', 'client-b');
    api.hold();
    const held = [start(handle.app, bearer(a), call(1, 'ynab_get_user')), start(handle.app, bearer(a), call(2, 'ynab_get_user'))];
    await until(() => api.waiting === 2, 'two held calls on client a');

    expectRefused(await mcpPost(handle.app, bearer(a), call(3, 'ynab_get_user'), '2025-06-18'), 3);
    // Client b of the same user takes the user's third slot...
    held.push(start(handle.app, bearer(b), call(4, 'ynab_get_user')));
    await until(() => api.waiting === 3, 'the held call on client b');
    // ...and then the per-user cap refuses it too.
    expectRefused(await mcpPost(handle.app, bearer(b), call(5, 'ynab_get_user'), '2025-06-18'), 5);

    api.release();
    for (const res of await Promise.all(held)) expect(res.status).toBe(200);
    await until(() => handle.inflight.inflight() === 0, 'slots released');
  });

  it('answers 429 past the process-wide cap, whoever asks', async () => {
    const { app } = await headerApp({ maxInflight: 2 });
    api.hold();
    const held = [start(app, ynabToken('token-a'), call(1, 'ynab_get_user')), start(app, ynabToken('token-b'), call(2, 'ynab_get_user'))];
    await until(() => api.waiting === 2, 'two held calls');
    expectRefused(await mcpPost(app, ynabToken('token-c'), { jsonrpc: '2.0', id: 3, method: 'ping' }), 3);
    api.release();
    await Promise.all(held);
  });

  it('refuses before reading storage', async () => {
    const { handle, storage, addUser, token } = await oauthApp({ maxInflightPerUser: 1, maxInflightPerClient: 1 });
    await addUser('u1', 'read-write');
    const a = await token('u1', 'client-a');
    api.hold();
    const held = start(handle.app, bearer(a), call(1, 'ynab_get_user'));
    await until(() => api.waiting === 1, 'the held call');
    const reads = vi.spyOn(storage, 'getUser');
    expectRefused(await mcpPost(handle.app, bearer(a), call(2, 'ynab_get_user'), '2025-06-18'), 2);
    expect(reads).not.toHaveBeenCalled();
    api.release();
    await held;
  });
});

describe('G2: the request ceiling and the tool-call deadline (D6, Q8)', () => {
  const TIMEOUT = 400;

  it('a stalled read tool returns "Request timed out" by the deadline; its slot and lease stay held until the call settles', async () => {
    const { app, inflight, registry } = await headerApp({ requestTimeoutMs: TIMEOUT });
    api.hold();
    const started = Date.now();
    const res = await mcpPost(app, ynabToken('token-a'), call(9, 'ynab_get_user'), '2025-06-18');
    expect(Date.now() - started).toBeLessThan(TIMEOUT);
    expect(res.status).toBe(200);
    const message = rpcMessageOrUndefined(res);
    expect(message?.['id']).toBe(9);
    expect(message?.['result']?.['isError']).toBe(true);
    const body = JSON.parse(toolText(res)) as Record<string, unknown>;
    expect(body).toMatchObject({ error: true, type: 'request_timeout', message: TOOL_TIMEOUT_MESSAGE });
    expect(body['outcome']).toBeUndefined();

    // The response is gone, but the YNAB call behind it is still running (D5).
    const userKey = (await import('../../src/services/user-registry.js')).headerUserKey('token-a');
    expect(inflight.inflight()).toBe(1);
    expect(registry.leases(userKey)).toBe(1);
    api.release();
    await until(() => inflight.inflight() === 0, 'the slot released once the call settled');
    expect(registry.leases(userKey)).toBe(0);
  });

  it('a stalled write says its outcome is unknown, never that it failed', async () => {
    const { app } = await headerApp({ requestTimeoutMs: TIMEOUT, readOnly: false });
    api.hold();
    const res = await mcpPost(app, ynabToken('token-a'), call(10, 'ynab_create_category_group', { budget_id: 'last-used', name: 'G' }), '2025-06-18');
    expect(res.status).toBe(200);
    const body = JSON.parse(toolText(res)) as Record<string, unknown>;
    expect(body).toMatchObject({ error: true, type: 'request_timeout', message: WRITE_TIMEOUT_MESSAGE, outcome: 'unknown' });
    expect(String(body['message'])).not.toMatch(/fail/i);
  });

  it('on a 2025 SSE stream with keepalives running, the timed-out write gets its result event before the stream ends', async () => {
    const { app } = await headerApp({ requestTimeoutMs: 600, readOnly: false }, { mcpKeepAliveMs: 50 });
    api.hold();
    const res = await mcpPost(app, ynabToken('token-a'), call(11, 'ynab_create_category_group', { budget_id: 'last-used', name: 'G' }), '2025-06-18');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const keepalive = res.text.indexOf(': keepalive');
    const event = res.text.indexOf('event: message');
    expect(keepalive).toBeGreaterThanOrEqual(0);
    expect(event).toBeGreaterThan(keepalive);
    const message = rpcMessageOrUndefined(res);
    expect(message?.['id']).toBe(11);
    expect(toolText(res)).toContain(WRITE_TIMEOUT_MESSAGE);
  });

  it('a slow resolve shortens the handler: a delayed resolver then a slow write still answers before the ceiling', async () => {
    const { handle, addUser, token } = await oauthApp({ requestTimeoutMs: 600, allowWrite: true });
    await addUser('u1', 'read-write');
    const access = await token('u1', 'client-a');
    // The YNAB token refresh inside resolve takes 300 ms of the 600 ms.
    refreshMock.mockImplementation(async () => {
      await sleep(300);
      return { accessToken: 'ynab-access', refreshToken: 'r2', expiresAt: Date.now() + 7_200_000 };
    });
    api.hold();
    const started = Date.now();
    const res = await mcpPost(handle.app, bearer(access), call(12, 'ynab_create_category_group', { budget_id: 'last-used', name: 'G' }), '2025-06-18');
    const elapsed = Date.now() - started;
    // Answered by the handler's deadline (request deadline less its margin), not a fresh 600 ms after resolve.
    expect(elapsed).toBeLessThan(600);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(res.status).toBe(200);
    expect(toolText(res)).toContain(WRITE_TIMEOUT_MESSAGE);
  });

  it('a stalled resolver hits the ceiling: a JSON-RPC error echoing the id; the slot stays held until resolve settles', async () => {
    const { handle, addUser, token } = await oauthApp({ requestTimeoutMs: TIMEOUT });
    await addUser('u1', 'read-write');
    const access = await token('u1', 'client-a');
    let finish: (() => void) | undefined;
    refreshMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ accessToken: 'ynab-access', refreshToken: 'r2', expiresAt: Date.now() + 7_200_000 });
        })
    );
    const res = await mcpPost(handle.app, bearer(access), call(13, 'ynab_get_user'), '2025-06-18');
    expect(res.status).toBe(504);
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Request timed out' }, id: 13 });

    // The resolve it started is still running: its slot is held, no lease was taken.
    expect(handle.inflight.inflight('u1')).toBe(1);
    expect(handle.registry.leases('u1')).toBe(0);
    finish?.();
    await until(() => handle.inflight.inflight() === 0, 'the slot released once resolve settled');
    // Nothing taken after the timeout is kept: no lease, and no YNAB call made.
    expect(handle.registry.leases('u1')).toBe(0);
    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it('a non-tool method that stalls on an open 2025 SSE stream has the stream ended at the ceiling, and frees its slot', async () => {
    const { app, inflight } = await headerApp({ requestTimeoutMs: 300 }, { mcpKeepAliveMs: 50 });
    vi.mocked(promptsModule.getPromptMessages).mockImplementationOnce(() => new Promise(() => undefined) as never);
    const started = Date.now();
    const res = await mcpPost(
      app,
      ynabToken('token-a'),
      { jsonrpc: '2.0', id: 14, method: 'prompts/get', params: { name: promptsModule.prompts[0]!.name, arguments: {} } },
      '2025-06-18'
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // The stream was open (keepalives) and ended without a result: nothing changed, so nothing to report (Q8).
    expect(res.text).toContain(': keepalive');
    expect(rpcMessageOrUndefined(res)).toBeUndefined();
    await until(() => inflight.inflight() === 0, 'the slot released');
    // The server keeps serving.
    expect((await mcpPost(app, ynabToken('token-a'), { jsonrpc: '2.0', id: 15, method: 'ping' })).status).toBe(200);
  });

  it('a body that never finishes arriving gets 408 with id null and Connection: close', async () => {
    const { app } = await headerApp({ requestTimeoutMs: 300 });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const answered = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '1000', accept: MCP_ACCEPT, 'x-ynab-token': 'token-a' },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          }
        );
        req.on('error', reject);
        // Half the declared body, then nothing.
        req.write('{"jsonrpc":"2.0","id":1,');
      });
      expect(answered.status).toBe(408);
      expect(answered.headers['connection']).toBe('close');
      expect(JSON.parse(answered.body)).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Request timed out' }, id: null });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('G2: abort on disconnect (D5)', () => {
  it('a client that disconnects mid-call frees nothing until the call settles, then frees everything', async () => {
    const handle = await headerApp();
    const server = handle.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      api.hold();
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, 'x-ynab-token': 'token-a', 'mcp-protocol-version': '2025-06-18' },
      });
      req.on('error', () => undefined);
      req.end(JSON.stringify(call(1, 'ynab_get_user')));
      await until(() => api.waiting === 1, 'the held YNAB call');
      const userKey = (await import('../../src/services/user-registry.js')).headerUserKey('token-a');
      expect(handle.inflight.inflight()).toBe(1);
      expect(handle.registry.leases(userKey)).toBe(1);

      // The client goes away; the response closes, the YNAB call is still running.
      req.destroy();
      await sleep(50);
      expect(handle.inflight.inflight()).toBe(1);
      expect(handle.registry.leases(userKey)).toBe(1);

      api.release();
      await until(() => handle.inflight.inflight() === 0, 'the slot released');
      expect(handle.registry.leases(userKey)).toBe(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('the YNAB token is never logged (D3)', () => {
  it('on any path: served, refused, timed out, or refused by the SDK', async () => {
    const TOKEN = 'ynab-secret-token-0123456789';
    const { app } = await headerApp({ requestTimeoutMs: 300, maxInflightPerUser: 1 });
    const errors = vi.mocked(console.error);
    errors.mockClear();
    const auth = ynabToken(TOKEN);

    expect((await mcpPost(app, auth, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    api.hold();
    const held = start(app, auth, call(2, 'ynab_get_user'));
    await until(() => api.waiting === 1, 'the held call');
    expect((await mcpPost(app, auth, call(3, 'ynab_get_user'), '2025-06-18')).status).toBe(429);
    expect((await held).status).toBe(200); // the tool's own timeout result
    api.release();
    // Refused by the SDK (reported through onerror): a protocol version it doesn't serve.
    expect((await mcpPost(app, auth, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, '1999-01-01')).status).toBe(400);
    expect((await request(app).post('/mcp').set(auth).set('Content-Type', 'application/json').send('{bad')).status).toBe(400);

    expect(errors).toHaveBeenCalled();
    const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(TOKEN.slice(0, 16));
  });
});

describe('startHttpServer', () => {
  it('warns once at startup about the retired session settings that are set', async () => {
    const errors = vi.mocked(console.error);
    errors.mockClear();
    const server = await startHttpServer(
      makeHttpConfig({ bindHost: '127.0.0.1', deprecatedSessionSettings: ['MCP_MAX_SESSIONS', 'MCP_SESSION_IDLE_TIMEOUT_MS'] })
    );
    try {
      await new Promise((resolve) => (server.listening ? resolve(undefined) : server.once('listening', resolve)));
      const warnings = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('MCP_MAX_SESSIONS'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('MCP_MAX_SESSIONS, MCP_SESSION_IDLE_TIMEOUT_MS have no effect');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('closing the http.Server lets a request in flight finish, then finishes', async () => {
    const server = await startHttpServer(makeHttpConfig({ bindHost: '127.0.0.1' }));
    await new Promise((resolve) => (server.listening ? resolve(undefined) : server.once('listening', resolve)));
    const { port } = server.address() as AddressInfo;
    api.hold();
    const inFlight = fetchReal(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, 'x-ynab-token': 'token-a', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify(call(1, 'ynab_get_user')),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
    await until(() => api.waiting === 1, 'the held call');

    let closed = false;
    const closing = new Promise<void>((resolve) =>
      server.close(() => {
        closed = true;
        resolve();
      })
    );
    await sleep(50);
    expect(closed).toBe(false);
    api.release();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.text).toContain('user-token-a');
    await closing;
    expect(closed).toBe(true);
  });
});

describe('the transaction feed state persists across requests (D5)', () => {
  it("is part of the user's components, which every request of that user gets", async () => {
    const handle = await headerApp();
    const first = handle.registry.acquire('k');
    first.components.feedState.sinceDateRejected = true;
    first.release();
    const second = handle.registry.acquire('k');
    expect(second.components.feedState).toBe(first.components.feedState);
    expect(second.components.feedState.sinceDateRejected).toBe(true);
    second.release();
    expect(handle.registry.acquire('other').components.feedState.sinceDateRejected).toBe(false);
  });
});
