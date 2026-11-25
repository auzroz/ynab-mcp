/**
 * An oversized body is refused with 413 and drained within bounds (#137):
 * a well-behaved client reads the status instead of a reset, and a slow or
 * huge upload cannot hold the connection.
 *
 * The assertions are about outcomes (413 read, connection closed by the
 * server, bytes cut off). Time checks are loose: a lower bound well below the
 * drain timer (a timer never fires early, so load cannot break it) and an
 * upper bound far above it, so only a missing bound fails them.
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
const sockets: net.Socket[] = [];
const intervals: NodeJS.Timeout[] = [];

afterEach(async () => {
  for (const t of intervals.splice(0)) clearInterval(t);
  for (const sock of sockets.splice(0)) sock.destroy();
  // close() waits for open connections; closeAllConnections() ends them, so a
  // failed test cannot leave a keep-alive socket holding the suite open.
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        })
    )
  );
});

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    // Node's own keep-alive timeout (about 6 s) would also close a stalled
    // upload once the 413 is sent; off, so only the drain bound can close it.
    s.keepAliveTimeout = 0;
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

/** Reject with a clear message if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Open a raw connection, send headers declaring `length` bytes, return helpers. */
function rawClient(port: number, path: string, length: number) {
  const socket = net.connect(port, '127.0.0.1');
  sockets.push(socket);
  let received = '';
  const status = (): string | undefined => /^HTTP\/1\.1 (\d+)/.exec(received)?.[1];
  let onStatus: () => void = () => undefined;
  const statusSeen = new Promise<void>((resolve) => (onStatus = resolve));
  const closed = new Promise<{ ms: number; error?: string }>((resolve) => {
    const start = Date.now();
    socket.on('data', (d) => {
      received += d.toString();
      if (status()) onStatus();
    });
    socket.on('error', (e) => resolve({ ms: Date.now() - start, error: e.message }));
    socket.on('close', () => resolve({ ms: Date.now() - start }));
  });
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${length}\r\n\r\n`
  );
  return { socket, closed, statusSeen, status, text: () => received };
}

describe('drainRequest bounds', () => {
  const respond413 = (req: http.IncomingMessage, res: http.ServerResponse, bytes: number, ms: number): void => {
    res.statusCode = 413;
    res.end('too large');
    drainRequest(req as Request, bytes, ms);
  };

  it('closes a slow, partial upload at the time bound, not before', async () => {
    const drainMs = 1000;
    const port = await listen((req, res) => respond413(req, res, 1024 * 1024, drainMs));
    const c = rawClient(port, '/', 600 * 1024);
    c.socket.write('x'.repeat(1024)); // then stall: only the time bound can end it
    const { ms } = await within(c.closed, 10_000, 'stalled upload closed');
    expect(c.status()).toBe('413');
    // Drained, not destroyed on the spot (which is what reset the client).
    expect(ms).toBeGreaterThanOrEqual(drainMs / 2);
  }, 20_000);

  it('cuts off a body over the byte bound', async () => {
    let seen = 0;
    const port = await listen((req, res) => {
      req.on('data', (c: Buffer) => (seen += c.length));
      // A time bound far past the test's deadline: only the byte bound can close it.
      respond413(req, res, 64 * 1024, 120_000);
    });
    const c = rawClient(port, '/', 4 * 1024 * 1024);
    c.socket.on('error', () => undefined);
    const chunk = Buffer.alloc(32 * 1024, 'x');
    intervals.push(
      setInterval(() => {
        if (!c.socket.destroyed) c.socket.write(chunk, () => undefined);
      }, 1)
    );
    await within(c.closed, 10_000, 'oversized upload cut off');
    expect(c.status()).toBe('413');
    // Cut off near the 64 KiB bound, nowhere near the declared 4 MiB.
    expect(seen).toBeLessThan(1024 * 1024);
  }, 20_000);

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
    // More than the socket buffers hold: the write completes only if the server reads it.
    const written = new Promise<void>((resolve, reject) =>
      c.socket.write('x'.repeat(600 * 1024), (err) => (err ? reject(err) : resolve()))
    );
    await within(Promise.all([written, c.statusSeen]), 10_000, 'body written and 413 read');
    // Keep-alive: the connection stays open after the drain, so end it from here.
    c.socket.end();
    const { error } = await within(c.closed, 10_000, 'connection closed');
    expect(error).toBeUndefined();
    expect(c.status()).toBe('413');
    expect(c.text()).toContain('payload too large');
  }, 30_000);

  it('closes a slow partial body on /mcp at the drain bound', async () => {
    const app = await createHttpApp(makeHttpConfig({ fallbackAccessToken: 'env-token' }));
    const port = await listen(app);
    const c = rawClient(port, '/mcp', 600 * 1024);
    c.socket.write('x'.repeat(1024)); // then stall; the request ceiling (60 s) is far off
    const { ms } = await within(c.closed, MAX_DRAIN_MS + 10_000, 'stalled /mcp upload closed');
    expect(c.status()).toBe('413');
    expect(ms).toBeGreaterThanOrEqual(MAX_DRAIN_MS / 2);
  }, 30_000);
});
