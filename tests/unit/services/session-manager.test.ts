import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionManager, type SessionManagerOptions } from '../../../src/services/session-manager.js';

/** A transport double whose close() runs onclose, like the real one. */
class FakeTransport {
  sessionId: string | undefined;
  onclose: (() => void) | undefined;
  closeCalls = 0;
  async close(): Promise<void> {
    this.closeCalls++;
    this.onclose?.();
  }
}

const asTransport = (t: FakeTransport): StreamableHTTPServerTransport => t as unknown as StreamableHTTPServerTransport;
const fakeRes = (): ServerResponse => new EventEmitter() as unknown as ServerResponse;

let clock = 0;
let sweepFn: (() => void) | undefined;
let sweepMs: number | undefined;
let sweepStopped: number;
let ids = 0;

function makeManager(opts: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({
    maxSessions: 100,
    maxSessionsPerUser: 10,
    idleTimeoutMs: 1000,
    now: () => clock,
    schedule: (fn, ms) => {
      sweepFn = fn;
      sweepMs = ms;
      return () => {
        sweepStopped++;
        sweepFn = undefined;
      };
    },
    ...opts,
  });
}

interface Opened {
  id: string;
  transport: FakeTransport;
  released: () => number;
}

/** Admit and register a session the way http.ts does. */
async function open(m: SessionManager, userKey: string | undefined, owner: string | undefined = 'owner'): Promise<Opened> {
  const admission = await m.admit(userKey);
  if (!admission) throw new Error('refused');
  const transport = new FakeTransport();
  let releases = 0;
  admission.bind(asTransport(transport), owner, () => releases++);
  const id = `s${++ids}`;
  transport.sessionId = id;
  admission.commit(id);
  admission.cancel();
  return { id, transport, released: () => releases };
}

beforeEach(() => {
  clock = 1_000_000;
  sweepFn = undefined;
  sweepMs = undefined;
  sweepStopped = 0;
  ids = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('find', () => {
  it('returns the session only for the identity that created it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = makeManager();
    const s = await open(m, 'u', 'alice');
    expect(m.find(s.id, 'alice', fakeRes())).toBe(s.transport);
    expect(m.find(s.id, 'bob', fakeRes())).toBeUndefined();
    expect(m.find(s.id, undefined, fakeRes())).toBeUndefined();
    expect(m.find('nope', 'alice', fakeRes())).toBeUndefined();
    expect(m.find(undefined, 'alice', fakeRes())).toBeUndefined();
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('[Session] rejected');
    expect(logged).not.toContain(s.id);
  });

  it('forgets a session when its transport closes, releasing it once', async () => {
    const m = makeManager();
    const s = await open(m, 'u');
    expect(m.size).toBe(1);
    await s.transport.close();
    await s.transport.close();
    expect(m.size).toBe(0);
    expect(s.released()).toBe(1);
    expect(m.find(s.id, 'owner', fakeRes())).toBeUndefined();
  });
});

describe('per-user cap', () => {
  it("closes the user's least recently used session to make room", async () => {
    const m = makeManager({ maxSessionsPerUser: 2 });
    const a = await open(m, 'u');
    clock += 10;
    const b = await open(m, 'u');
    clock += 10;
    // Using a makes b the least recently used.
    m.find(a.id, 'owner', fakeRes());
    clock += 10;
    const c = await open(m, 'u');

    expect(b.transport.closeCalls).toBe(1);
    expect(b.released()).toBe(1);
    expect(a.transport.closeCalls).toBe(0);
    expect(c.transport.closeCalls).toBe(0);
    expect(m.find(b.id, 'owner', fakeRes())).toBeUndefined();
    expect(m.find(a.id, 'owner', fakeRes())).toBe(a.transport);
    expect(m.size).toBe(2);
  });

  it('prefers a session with nothing in flight over one with an open stream', async () => {
    const m = makeManager({ maxSessionsPerUser: 2 });
    const streaming = await open(m, 'u');
    clock += 10;
    const quiet = await open(m, 'u');
    clock += 10;
    m.find(streaming.id, 'owner', fakeRes()); // open request, never closed
    await open(m, 'u');
    expect(quiet.transport.closeCalls).toBe(1);
    expect(streaming.transport.closeCalls).toBe(0);
  });

  it('does not touch other users, and a cap of 1 keeps just the newest session', async () => {
    const m = makeManager({ maxSessionsPerUser: 1 });
    const other = await open(m, 'other');
    const first = await open(m, 'u');
    const second = await open(m, 'u');
    expect(first.transport.closeCalls).toBe(1);
    expect(second.transport.closeCalls).toBe(0);
    expect(other.transport.closeCalls).toBe(0);
    expect(m.size).toBe(2);
  });

  it('counts an initialization in progress, so concurrent initializes cannot overshoot', async () => {
    const m = makeManager({ maxSessionsPerUser: 1 });
    const first = await m.admit('u');
    expect(first).toBeDefined();
    // Nothing live to close yet: refused rather than exceeding the cap.
    expect(await m.admit('u')).toBeUndefined();
    first?.cancel();
    expect(await m.admit('u')).toBeDefined();
  });
});

describe('global cap', () => {
  it('refuses new sessions at the cap without closing anyone', async () => {
    const m = makeManager({ maxSessions: 2, maxSessionsPerUser: 5 });
    const a = await open(m, 'a');
    const b = await open(m, 'b');
    expect(await m.admit('c')).toBeUndefined();
    expect(await m.admit('a')).toBeUndefined();
    expect(a.transport.closeCalls + b.transport.closeCalls).toBe(0);

    await a.transport.close();
    expect(await m.admit('c')).toBeDefined();
  });

  it('lets a user at their own cap replace a session even when the global cap is full', async () => {
    const m = makeManager({ maxSessions: 2, maxSessionsPerUser: 1 });
    const a = await open(m, 'a');
    await open(m, 'b');
    const again = await open(m, 'a');
    expect(a.transport.closeCalls).toBe(1);
    expect(again.transport.closeCalls).toBe(0);
    expect(m.size).toBe(2);
  });

  it('counts sessions without a user only toward the global cap', async () => {
    const m = makeManager({ maxSessions: 3, maxSessionsPerUser: 1 });
    await open(m, undefined);
    await open(m, undefined);
    const third = await open(m, undefined);
    expect(third.transport.closeCalls).toBe(0);
    expect(m.size).toBe(3);
    expect(await m.admit(undefined)).toBeUndefined();
  });

  it('counts initializations in progress, and frees the slot on cancel', async () => {
    const m = makeManager({ maxSessions: 1 });
    const pending = await m.admit('a');
    expect(await m.admit('b')).toBeUndefined();
    pending?.cancel();
    expect(await m.admit('b')).toBeDefined();
  });

  it('releases an admission cancelled without a session, once', async () => {
    const m = makeManager();
    const admission = await m.admit('u');
    let releases = 0;
    admission?.bind(asTransport(new FakeTransport()), 'owner', () => releases++);
    admission?.cancel();
    admission?.cancel();
    expect(releases).toBe(1);
  });
});

describe('idle sweep', () => {
  it('closes a session idle for the timeout, and only that one', async () => {
    const m = makeManager({ idleTimeoutMs: 1000 });
    const idle = await open(m, 'u');
    clock += 600;
    const recent = await open(m, 'u');
    clock += 600;
    await m.sweep();
    expect(idle.transport.closeCalls).toBe(1);
    expect(idle.released()).toBe(1);
    expect(recent.transport.closeCalls).toBe(0);
    expect(m.find(idle.id, 'owner', fakeRes())).toBeUndefined();
  });

  it('counts each request as activity', async () => {
    const m = makeManager({ idleTimeoutMs: 1000 });
    const s = await open(m, 'u');
    for (let i = 0; i < 3; i++) {
      clock += 600;
      const res = fakeRes();
      m.find(s.id, 'owner', res);
      res.emit('close');
      await m.sweep();
    }
    expect(s.transport.closeCalls).toBe(0);
    clock += 1000;
    await m.sweep();
    expect(s.transport.closeCalls).toBe(1);
  });

  it('never sweeps a session with an open request (a GET stream), until it ends', async () => {
    const m = makeManager({ idleTimeoutMs: 1000 });
    const s = await open(m, 'u');
    const stream = fakeRes();
    m.find(s.id, 'owner', stream);
    clock += 10 * 1000;
    await m.sweep();
    expect(s.transport.closeCalls).toBe(0);

    // Ending the stream starts the idle clock from then.
    stream.emit('close');
    clock += 500;
    await m.sweep();
    expect(s.transport.closeCalls).toBe(0);
    clock += 500;
    await m.sweep();
    expect(s.transport.closeCalls).toBe(1);
  });

  it('runs the sweep on a timer only while sessions exist', async () => {
    const m = makeManager({ idleTimeoutMs: 1000 });
    expect(sweepFn).toBeUndefined();
    const s = await open(m, 'u');
    expect(sweepMs).toBe(500);
    clock += 1000;
    sweepFn?.();
    await vi.waitFor(() => expect(s.transport.closeCalls).toBe(1));
    expect(sweepStopped).toBe(1);
    expect(sweepFn).toBeUndefined();
  });

  it('caps the sweep interval at a minute', async () => {
    const m = makeManager({ idleTimeoutMs: 30 * 60 * 1000 });
    await open(m, 'u');
    expect(sweepMs).toBe(60_000);
  });

  it('sweeps on the default timer when none is injected', async () => {
    vi.useFakeTimers();
    try {
      const m = new SessionManager({ maxSessions: 5, maxSessionsPerUser: 5, idleTimeoutMs: 1000 });
      const s = await open(m, 'u');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(s.transport.closeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('close', () => {
  it('stops the sweep, closes every session and refuses new ones', async () => {
    const m = makeManager();
    const a = await open(m, 'a');
    const b = await open(m, 'b');
    await m.close();
    expect(a.transport.closeCalls).toBe(1);
    expect(b.transport.closeCalls).toBe(1);
    expect(a.released()).toBe(1);
    expect(b.released()).toBe(1);
    expect(m.size).toBe(0);
    expect(sweepStopped).toBe(1);
    expect(await m.admit('a')).toBeUndefined();
  });

  it('survives a transport that fails to close', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = makeManager();
    const a = await open(m, 'a');
    a.transport.close = () => Promise.reject(new Error('boom: secret detail'));
    await expect(m.close()).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('secret detail');
  });
});
