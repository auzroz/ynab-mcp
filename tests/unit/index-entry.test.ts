/**
 * Process entry (src/entry.ts): transport resolution, the shutdown deadline,
 * and which process handlers each transport installs.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const startHttpServer = vi.hoisted(() => vi.fn());
vi.mock('../../src/http.js', () => ({ startHttpServer }));
const serveStdio = vi.hoisted(() => vi.fn(() => ({ close: vi.fn(async () => undefined) })));
vi.mock('../../src/server.js', () => ({
  createStdioServerFactory: () => () => ({}),
}));
vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio }));

import { main, resolveTransport, shutdownWithDeadline, SHUTDOWN_DEADLINE_MS } from '../../src/entry.js';

describe('resolveTransport', () => {
  it('defaults to stdio when unset or empty', () => {
    expect(resolveTransport({})).toBe('stdio');
    expect(resolveTransport({ MCP_TRANSPORT: '' })).toBe('stdio');
    expect(resolveTransport({ MCP_TRANSPORT: '  ' })).toBe('stdio');
  });
  it('accepts stdio and http, case-insensitively', () => {
    expect(resolveTransport({ MCP_TRANSPORT: 'stdio' })).toBe('stdio');
    expect(resolveTransport({ MCP_TRANSPORT: 'HTTP' })).toBe('http');
  });
  it('refuses anything else without echoing it', () => {
    for (const bad of ['htpp', 'sse', 'websocket']) {
      expect(() => resolveTransport({ MCP_TRANSPORT: bad })).toThrow(/Invalid MCP_TRANSPORT. Expected: stdio or http\./);
      expect(() => resolveTransport({ MCP_TRANSPORT: bad })).not.toThrow(new RegExp(bad));
    }
  });
});

describe('shutdownWithDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('exits 0 once close finishes', async () => {
    const exit = vi.fn();
    await shutdownWithDeadline({ close: async () => undefined, exit, log: () => undefined });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it('still exits 0 when close throws, and logs only the message', async () => {
    const exit = vi.fn();
    const log = vi.fn();
    await shutdownWithDeadline({ close: async () => { throw new Error('boom'); }, exit, log });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log.mock.calls.flat().join('\n')).toContain('boom');
  });
  it('exits 1 when close outlasts the deadline', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const pending = shutdownWithDeadline({ close: () => new Promise<void>(() => undefined), exit, log: () => undefined });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('the deadline is 10 s', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBe(10_000);
  });
});

describe('main', () => {
  beforeEach(() => {
    // main installs SIGINT/SIGTERM/unhandledRejection handlers; not in the test worker.
    vi.spyOn(process, 'on').mockImplementation(() => process);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    startHttpServer.mockReset();
    serveStdio.mockClear();
  });

  it('refuses an unknown MCP_TRANSPORT before starting anything', async () => {
    await expect(main({ MCP_TRANSPORT: 'htpp' })).rejects.toThrow(/Invalid MCP_TRANSPORT/);
    expect(startHttpServer).not.toHaveBeenCalled();
    expect(serveStdio).not.toHaveBeenCalled();
  });

  it('installs the unhandledRejection handler for every transport', async () => {
    startHttpServer.mockResolvedValue({ close: vi.fn() });
    await main({ MCP_TRANSPORT: 'http', AUTH_MODE: 'header' });
    const events = vi.mocked(process.on).mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'unhandledRejection']));
  });

  it('http: loads the HTTP config (AUTH_MODE required) and installs no stdin listener', async () => {
    const stdinBefore = process.stdin.listenerCount('close');
    await expect(main({ MCP_TRANSPORT: 'http' })).rejects.toThrow(/AUTH_MODE is required/);
    startHttpServer.mockResolvedValue({ close: vi.fn() });
    await main({ MCP_TRANSPORT: 'http', AUTH_MODE: 'header' });
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(startHttpServer.mock.calls[0]?.[0]).toMatchObject({ authMode: 'header' });
    expect(process.stdin.listenerCount('close')).toBe(stdinBefore);
  });

  it('stdio: listens for stdin closing, which ends the session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdinBefore = process.stdin.listenerCount('close');
    const prior = { token: process.env['YNAB_ACCESS_TOKEN'] };
    process.env['YNAB_ACCESS_TOKEN'] = 'dummy-token';
    try {
      await main({});
      expect(process.stdin.listenerCount('close')).toBe(stdinBefore + 1);
      expect(serveStdio).toHaveBeenCalledTimes(1);
    } finally {
      if (prior.token === undefined) delete process.env['YNAB_ACCESS_TOKEN'];
      else process.env['YNAB_ACCESS_TOKEN'] = prior.token;
    }
  });
});
