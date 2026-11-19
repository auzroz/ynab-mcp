/**
 * The HTTP extension points (src/http/extensions.ts): route modules mounted
 * after Host validation, the authorization server and the JSON parser and
 * before /mcp, never reached for /mcp itself; job modules started once
 * storage is ready and stopped on the server's shutdown path, before close()
 * calls back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { buildHttpApp, startHttpServer } from '../../src/http.js';
import {
  createJobRunner,
  type ExtensionContext,
  type JobExtension,
  type RouteExtension,
} from '../../src/http/extensions.js';
import { makeHttpConfig } from './helpers/http-config.js';

const HOST = 'mcp.example.com';

const oauthConfig = () =>
  makeHttpConfig({
    publicUrl: `https://${HOST}`,
    resourceUrl: `https://${HOST}/mcp`,
    authMode: 'oauth',
    oauthClientId: 'cid',
    oauthClientSecret: 'sec',
    encryptionKey: randomBytes(32).toString('base64'),
  });

/** A route module that echoes what it saw. */
function echoRoute(seen: ExtensionContext[] = []): RouteExtension {
  return {
    name: 'echo',
    mount(router, ctx) {
      seen.push(ctx);
      router.all('/ext/echo', (req, res) => {
        res.json({ body: req.body ?? null, hasStorage: ctx.storage !== undefined });
      });
      // Under /mcp on purpose: extension routes must never answer there.
      router.get('/mcp/ext-probe', (_req, res) => {
        res.json({ ok: true });
      });
      router.post('/mcp', (_req, res) => {
        res.json({ ok: true });
      });
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('route extensions', () => {
  it('mounts each route module once, with the config and (oauth mode) the storage', async () => {
    const seen: ExtensionContext[] = [];
    const config = oauthConfig();
    const { app } = await buildHttpApp(config, { routes: [echoRoute(seen)] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.config).toBe(config);
    expect(seen[0]?.storage).toBeDefined();
    const res = await request(app).get('/ext/echo');
    expect(res.status).toBe(200);
    expect(res.body.hasStorage).toBe(true);
  });

  it('gives a header-mode route module no storage', async () => {
    const { app } = await buildHttpApp(makeHttpConfig(), { routes: [echoRoute()] });
    expect((await request(app).get('/ext/echo')).body.hasStorage).toBe(false);
  });

  it('runs after host validation', async () => {
    const trace: string[] = [];
    const { app } = await buildHttpApp(
      makeHttpConfig({ enableDnsRebindingProtection: true, allowedHosts: [HOST] }),
      { routes: [echoRoute()], observeStage: (s) => trace.push(s) }
    );
    expect((await request(app).get('/ext/echo').set('Host', 'evil.example')).status).toBe(403);
    expect(trace).toEqual(['host-validation']);
    expect((await request(app).get('/ext/echo').set('Host', HOST)).status).toBe(200);
  });

  it('runs after the global JSON parser, with its 512kb limit', async () => {
    const { app } = await buildHttpApp(makeHttpConfig(), { routes: [echoRoute()] });
    const ok = await request(app).post('/ext/echo').send({ a: 1 });
    expect(ok.body.body).toEqual({ a: 1 });
    const big = await request(app)
      .post('/ext/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(600 * 1024) }));
    expect(big.status).toBe(413);
  });

  it('never runs for /mcp or under it, so it cannot get ahead of the bearer check (oauth mode)', async () => {
    const { app } = await buildHttpApp(oauthConfig(), { routes: [echoRoute()] });
    for (const path of ['/mcp/ext-probe', '/MCP/ext-probe', '/mcp/ext-probe/']) {
      // The MCP endpoint is exactly /mcp (ADR-0001 D1); under it nothing
      // answers, the extension's handler included.
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('"ok":true');
    }
    // /mcp itself is unchanged: still the bearer check, not the extension's handler.
    const mcp = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(mcp.status).toBe(401);
    expect(mcp.headers['www-authenticate']).toContain('Bearer');
    // The module's other routes still answer.
    expect((await request(app).get('/ext/echo')).status).toBe(200);
  });

  it('never runs for /mcp or under it (header mode)', async () => {
    const { app } = await buildHttpApp(makeHttpConfig(), { routes: [echoRoute()] });
    expect((await request(app).get('/mcp/ext-probe')).status).toBe(404);
    // /mcp's own pipeline answers: no YNAB token.
    const mcp = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(mcp.status).toBe(401);
    expect(mcp.text).not.toContain('"ok":true');
  });
});

describe('job runner', () => {
  const ctx: ExtensionContext = { config: makeHttpConfig(), storage: undefined };

  it('starts each job once, in order, and stops each started job', async () => {
    const order: string[] = [];
    const job = (name: string): JobExtension => ({
      name,
      start: () => {
        order.push(`start ${name}`);
        return { stop: () => void order.push(`stop ${name}`) };
      },
    });
    const runner = createJobRunner([job('a'), job('b')], ctx);
    runner.start();
    runner.start();
    expect(order).toEqual(['start a', 'start b']);
    await runner.stop();
    await runner.stop();
    expect(order).toEqual(['start a', 'start b', 'stop a', 'stop b']);
  });

  it('skips a job whose start returns nothing', async () => {
    const runner = createJobRunner([{ name: 'n/a', start: () => undefined }], ctx);
    runner.start();
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it('stops the started jobs and rethrows when a later job fails to start', async () => {
    const stopA = vi.fn();
    const runner = createJobRunner(
      [
        { name: 'a', start: () => ({ stop: stopA }) },
        {
          name: 'b',
          start: () => {
            throw new Error('boom');
          },
        },
      ],
      ctx
    );
    expect(() => runner.start()).toThrow('boom');
    await Promise.resolve();
    expect(stopA).toHaveBeenCalledTimes(1);
  });

  it('logs a job that fails to stop and still stops the others', async () => {
    const stopB = vi.fn();
    const runner = createJobRunner(
      [
        { name: 'a', start: () => ({ stop: () => Promise.reject(new Error('stuck')) }) },
        { name: 'b', start: () => ({ stop: stopB }) },
      ],
      ctx
    );
    runner.start();
    await expect(runner.stop()).resolves.toBeUndefined();
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('[Job] a failed to stop:', expect.any(String));
  });
});

describe('jobs and the server lifecycle', () => {
  it('buildHttpApp does not start jobs', async () => {
    const start = vi.fn(() => undefined);
    await buildHttpApp(makeHttpConfig(), { jobs: [{ name: 'j', start }] });
    expect(start).not.toHaveBeenCalled();
  });

  it('startHttpServer starts jobs once with storage ready, and closing the server stops them', async () => {
    const stop = vi.fn();
    const seen: ExtensionContext[] = [];
    const start = vi.fn((c: ExtensionContext) => {
      seen.push(c);
      return { stop };
    });
    const server = await startHttpServer(oauthConfig(), { jobs: [{ name: 'j', start }] });
    try {
      expect(start).toHaveBeenCalledTimes(1);
      expect(seen[0]?.storage).toBeDefined();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('calls the close callback only after an async job stop has finished', async () => {
    const order: string[] = [];
    const server = await startHttpServer(makeHttpConfig(), {
      jobs: [
        {
          name: 'slow',
          start: () => ({
            stop: () =>
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  order.push('job stopped');
                  resolve();
                }, 50)
              ),
          }),
        },
      ],
    });
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    await new Promise<void>((resolve) =>
      server.close(() => {
        order.push('close callback');
        resolve();
      })
    );
    expect(order).toEqual(['job stopped', 'close callback']);
  });

  it('passes a close error to the callback after the jobs stop', async () => {
    const stop = vi.fn();
    const server = await startHttpServer(makeHttpConfig(), { jobs: [{ name: 'j', start: () => ({ stop }) }] });
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Closing again: Node reports the server is not running.
    const err = await new Promise<Error | undefined>((resolve) => server.close((e) => resolve(e)));
    expect((err as NodeJS.ErrnoException | undefined)?.code).toBe('ERR_SERVER_NOT_RUNNING');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
