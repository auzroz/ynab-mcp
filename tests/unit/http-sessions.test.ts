/**
 * Session management over HTTP (header mode): the global and per-user caps,
 * idle expiry, 404 for session ids the server doesn't hold, and shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { buildHttpApp, createHttpApp, startHttpServer } from '../../src/http.js';
import { makeHttpConfig } from './helpers/http-config.js';

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

async function init(app: Express, token: string): Promise<string> {
  const res = await mcp(app, 'post', token).send(initializeBody);
  expect(res.status).toBe(200);
  return res.headers['mcp-session-id'] as string;
}

async function usable(app: Express, token: string, sid: string): Promise<boolean> {
  const res = await mcp(app, 'post', token, sid).send(toolsList);
  if (res.status === 404) return false;
  expect(res.status).toBe(200);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('per-user session cap', () => {
  it("closes the user's least recently used session instead of refusing", async () => {
    const app = await createHttpApp(makeHttpConfig({ maxSessionsPerUser: 2 }));
    const s1 = await init(app, 'token-a');
    const s2 = await init(app, 'token-a');
    const other = await init(app, 'token-b');
    // Using s1 makes s2 the least recently used.
    expect(await usable(app, 'token-a', s1)).toBe(true);

    const s3 = await init(app, 'token-a');
    expect(await usable(app, 'token-a', s2)).toBe(false);
    expect(await usable(app, 'token-a', s1)).toBe(true);
    expect(await usable(app, 'token-a', s3)).toBe(true);
    // Another user's session is not affected.
    expect(await usable(app, 'token-b', other)).toBe(true);
  });

  it('lets a client that leaks sessions keep connecting', async () => {
    const app = await createHttpApp(makeHttpConfig({ maxSessionsPerUser: 2 }));
    let last = '';
    for (let i = 0; i < 6; i++) last = await init(app, 'token-a');
    expect(await usable(app, 'token-a', last)).toBe(true);
  });
});

describe('global session cap', () => {
  it('answers 503 with Retry-After and a generic JSON-RPC error when full', async () => {
    const app = await createHttpApp(makeHttpConfig({ maxSessions: 2 }));
    const a = await init(app, 'token-a');
    await init(app, 'token-b');

    const res = await mcp(app, 'post', 'token-c').send(initializeBody);
    expect(res.status).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Service unavailable: too many active sessions, retry later' },
      id: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('token-c');

    // Existing sessions are untouched, and closing one makes room again.
    expect(await usable(app, 'token-a', a)).toBe(true);
    expect((await mcp(app, 'delete', 'token-a', a)).status).toBe(200);
    expect((await mcp(app, 'post', 'token-c').send(initializeBody)).status).toBe(200);
  });

  it('does not hold the registry for a refused initialize', async () => {
    const app = await createHttpApp(makeHttpConfig({ maxSessions: 1 }));
    await init(app, 'token-a');
    for (let i = 0; i < 3; i++) {
      expect((await mcp(app, 'post', 'token-b').send(initializeBody)).status).toBe(503);
    }
  });
});

describe('unknown session ids get 404 (the client re-initializes)', () => {
  it('on POST, GET and DELETE, identically for unknown and foreign ids', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const sid = await init(app, 'token-a');

    for (const method of ['post', 'get', 'delete'] as const) {
      const send = (token: string | undefined, id: string): request.Test => {
        const req = mcp(app, method, token, id);
        return method === 'post' ? req.send(toolsList) : req;
      };
      const unknown = await send('token-a', 'no-such-session');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });

      const foreign = await send('token-b', sid);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(unknown.body);
    }
    expect(await usable(app, 'token-a', sid)).toBe(true);
  });

  it('after the session was closed', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const sid = await init(app, 'token-a');
    expect((await mcp(app, 'delete', 'token-a', sid)).status).toBe(200);
    expect((await mcp(app, 'post', 'token-a', sid).send(toolsList)).status).toBe(404);
    expect((await mcp(app, 'get', 'token-a', sid)).status).toBe(404);
    expect((await mcp(app, 'delete', 'token-a', sid)).status).toBe(404);
  });

  it('but a request without any session id stays 400', async () => {
    const app = await createHttpApp(makeHttpConfig());
    expect((await mcp(app, 'post', 'token-a').send(toolsList)).status).toBe(400);
    expect((await mcp(app, 'get', 'token-a')).status).toBe(400);
    expect((await mcp(app, 'delete', 'token-a')).status).toBe(400);
  });
});

describe('idle timeout', () => {
  it('closes an idle session (404 afterwards) and keeps a busy one', async () => {
    const app = await createHttpApp(makeHttpConfig({ sessionIdleTimeoutMs: 100 }));
    const idle = await init(app, 'token-a');
    const busy = await init(app, 'token-a');
    for (let i = 0; i < 6; i++) {
      await sleep(40);
      expect(await usable(app, 'token-a', busy)).toBe(true);
    }
    expect(await usable(app, 'token-a', idle)).toBe(false);
    expect(await usable(app, 'token-a', busy)).toBe(true);
  });
});

describe('shutdown', () => {
  it('SessionManager.close() closes every session', async () => {
    const { app, sessions } = await buildHttpApp(makeHttpConfig());
    const sid = await init(app, 'token-a');
    await init(app, 'token-b');
    expect(sessions.size).toBe(2);
    await sessions.close();
    expect(sessions.size).toBe(0);
    expect(await usable(app, 'token-a', sid)).toBe(false);
    expect((await mcp(app, 'post', 'token-c').send(initializeBody)).status).toBe(503);
  });

  /** Open a session and its standalone GET stream on a real server. */
  async function streamOn(server: http.Server, token: string): Promise<{ sid: string; stream: http.IncomingMessage }> {
    const { port } = server.address() as AddressInfo;
    const base = { host: '127.0.0.1', port, path: '/mcp' };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ynab-token': token };
    const sid = await new Promise<string>((resolve, reject) => {
      const req = http.request({ ...base, method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['mcp-session-id'] as string));
      });
      req.on('error', reject);
      req.end(JSON.stringify(initializeBody));
    });
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ ...base, method: 'GET', headers: { ...headers, 'mcp-session-id': sid } }, resolve);
      req.on('error', reject);
      req.end();
    });
    return { sid, stream };
  }

  it('an open GET stream keeps its session from the idle sweep until it ends', async () => {
    const server = await startHttpServer(makeHttpConfig({ sessionIdleTimeoutMs: 100 }));
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const { sid, stream } = await streamOn(server, 'token-a');
      expect(stream.statusCode).toBe(200);

      // Several idle timeouts later the session is still there.
      await sleep(350);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const alive = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ynab-token': 'token-a', 'mcp-session-id': sid },
        body: JSON.stringify(toolsList),
      });
      expect(alive.status).toBe(200);
      await alive.text();

      // Once the stream ends the session idles out.
      stream.destroy();
      await sleep(350);
      const gone = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ynab-token': 'token-a', 'mcp-session-id': sid },
        body: JSON.stringify(toolsList),
      });
      expect(gone.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('closing the http.Server closes its sessions, even with a stream open', async () => {
    const server = await startHttpServer(makeHttpConfig());
    await new Promise((resolve) => server.once('listening', resolve));
    const { stream } = await streamOn(server, 'token-a');
    const streamEnded = new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
      stream.on('error', () => resolve());
      stream.resume();
    });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([streamEnded, closed]);
  });
});
