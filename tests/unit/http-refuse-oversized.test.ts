/**
 * An oversized body is refused with 413 and drained within bounds (#137):
 * a well-behaved client reads the status instead of a reset, and a slow or
 * huge upload cannot hold the connection.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { createHttpApp } from '../../src/http.js';
import { drainRequest, MAX_DRAIN_BYTES, MAX_DRAIN_MS } from '../../src/http/refuse-oversized.js';
import { makeHttpConfig } from './helpers/http-config.js';

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

/** Open a raw connection, send headers declaring `length` bytes, return helpers. */
function rawClient(port: number, path: string, length: number) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  const closed = new Promise<{ ms: number; error?: string }>((resolve) => {
    const start = Date.now();
    socket.on('data', (d) => (received += d.toString()));
    socket.on('error', (e) => resolve({ ms: Date.now() - start, error: e.message }));
    socket.on('close', () => resolve({ ms: Date.now() - start }));
  });
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${length}\r\n\r\n`
  );
  return { socket, closed, status: () => /^HTTP\/1\.1 (\d+)/.exec(received)?.[1], text: () => received };
}

describe('drainRequest bounds', () => {
  const respond413 = (req: http.IncomingMessage, res: http.ServerResponse, bytes: number, ms: number): void => {
    res.statusCode = 413;
    res.end('too large');
    drainRequest(req as Request, bytes, ms);
  };

  it('closes a slow, partial upload within the time bound', async () => {
    const port = await listen((req, res) => respond413(req, res, 1024 * 1024, 300));
    const c = rawClient(port, '/', 600 * 1024);
    c.socket.write('x'.repeat(1024)); // then stall
    const { ms } = await c.closed;
    expect(c.status()).toBe('413');
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(2000);
  });

  it('cuts off a body over the byte bound', async () => {
    let seen = 0;
    const port = await listen((req, res) => {
      req.on('data', (c: Buffer) => (seen += c.length));
      respond413(req, res, 64 * 1024, 10_000);
    });
    const c = rawClient(port, '/', 4 * 1024 * 1024);
    const chunk = Buffer.alloc(32 * 1024, 'x');
    const timer = setInterval(() => {
      if (!c.socket.destroyed) c.socket.write(chunk, () => undefined);
    }, 1);
    c.socket.on('error', () => undefined);
    const { ms } = await c.closed;
    clearInterval(timer);
    expect(c.status()).toBe('413');
    expect(ms).toBeLessThan(5000);
    // Cut off near the bound, nowhere near the declared 4 MiB.
    expect(seen).toBeLessThan(1024 * 1024);
  });

  it('keeps the production bounds small', () => {
    expect(MAX_DRAIN_BYTES).toBe(1024 * 1024);
    expect(MAX_DRAIN_MS).toBeLessThanOrEqual(5000);
  });
});

describe('/mcp early 413', () => {
  it('answers 413 for a Content-Length over 512kb and drains the whole body without a reset', async () => {
    const app = await createHttpApp(makeHttpConfig({ fallbackAccessToken: 'env-token' }));
    const port = await listen(app);
    const c = rawClient(port, '/mcp', 600 * 1024);
    c.socket.write('x'.repeat(600 * 1024));
    // Keep-alive: the connection stays open after the drain, so end it from here.
    await new Promise((r) => setTimeout(r, 300));
    c.socket.end();
    const { error } = await c.closed;
    expect(error).toBeUndefined();
    expect(c.status()).toBe('413');
    expect(c.text()).toContain('payload too large');
  });

  it('closes a slow partial body on /mcp within the drain bound', async () => {
    const app = await createHttpApp(makeHttpConfig({ fallbackAccessToken: 'env-token' }));
    const port = await listen(app);
    const c = rawClient(port, '/mcp', 600 * 1024);
    c.socket.write('x'.repeat(1024));
    const { ms } = await c.closed;
    expect(c.status()).toBe('413');
    expect(ms).toBeLessThan(MAX_DRAIN_MS + 2000);
  }, 15_000);
});
