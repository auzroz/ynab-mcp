/**
 * Live MCP sessions (HTTP mode): lookup bound to the creating identity, caps,
 * and idle expiry.
 *
 * A session holds a server, a transport and a hold on its user's shared state
 * (UserRegistry) until it closes, so an unbounded number of them is an
 * unbounded cost. Three limits keep it bounded:
 *  - a global cap (`MCP_MAX_SESSIONS`): past it new sessions are refused;
 *  - a per-user cap (`MCP_MAX_SESSIONS_PER_USER`): past it the user's least
 *    recently used session is closed to make room, so a client that leaks
 *    sessions evicts its own old ones instead of locking itself out or eating
 *    the global cap that other users share;
 *  - an idle timeout (`MCP_SESSION_IDLE_TIMEOUT_MS`): a session with no request
 *    in flight and none seen for that long is closed.
 * A session counts as active for as long as any request on it is open, which
 * includes the standalone GET SSE stream.
 */

import type { ServerResponse } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Upper bound on the time between idle sweeps. */
const MAX_SWEEP_INTERVAL_MS = 60_000;

export interface SessionManagerOptions {
  /** Global cap on live sessions (a session being initialized counts). */
  maxSessions: number;
  /** Cap on one user's live sessions; the user's LRU session is closed past it. */
  maxSessionsPerUser: number;
  /** Idle time after which a session is closed. */
  idleTimeoutMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /**
   * Run `fn` every `ms` until the returned function is called. The default is
   * an unref'd setInterval, so the sweep never keeps the process alive.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Session {
  readonly id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly owner: string | undefined;
  /** Quota key (the user), when there is one. */
  readonly userKey: string | undefined;
  lastActivityAt: number;
  /** Requests currently open on the session (an SSE stream stays open). */
  openRequests: number;
}

/**
 * A slot for a session being initialized. It counts toward the caps from
 * `admit` until the session registers, so concurrent initializes can't
 * overshoot them.
 */
export interface Admission {
  /**
   * Tie the transport to this slot. Call before connecting the server to the
   * transport. `release` runs once, when the session closes or the admission
   * is cancelled without a session (use it to give back the user's hold).
   */
  bind(transport: StreamableHTTPServerTransport, owner: string | undefined, release: () => void): void;
  /** The transport assigned the session id: the session is now live. */
  commit(sessionId: string): void;
  /** Initialization ended; a no-op once committed. */
  cancel(): void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** Admissions not yet committed, in total and per user. */
  private pending = 0;
  private readonly pendingByUser = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly maxSessionsPerUser: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private stopSweep: (() => void) | undefined;
  private closed = false;

  constructor(opts: SessionManagerOptions) {
    this.maxSessions = opts.maxSessions;
    this.maxSessionsPerUser = opts.maxSessionsPerUser;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * The session `sessionId` names, only if `owner` is the identity that created
   * it. A session id presented with another identity is treated exactly like an
   * unknown id, so ids leaked from logs can't be used to drive someone else's
   * session, nor probed. A hit counts as activity, and keeps the session active
   * until `res` closes.
   */
  find(
    sessionId: string | undefined,
    owner: string | undefined,
    res: ServerResponse
  ): StreamableHTTPServerTransport | undefined {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return undefined;
    if (session.owner !== owner) {
      console.error('[Session] rejected a request for a session owned by a different identity');
      return undefined;
    }
    session.lastActivityAt = this.now();
    session.openRequests++;
    res.once('close', () => {
      session.openRequests--;
      session.lastActivityAt = this.now();
    });
    return session.transport;
  }

  /**
   * Make room for a new session of `userKey` (none: counts only toward the
   * global cap). Closes the user's least recently used session when the user is
   * at their cap. Returns undefined when the global cap leaves no room.
   */
  async admit(userKey: string | undefined): Promise<Admission | undefined> {
    if (this.closed) return undefined;

    const evicted: Session[] = [];
    if (userKey !== undefined) {
      while (this.userCount(userKey) >= this.maxSessionsPerUser) {
        const victim = this.leastRecentlyUsed(userKey);
        // Only unfinished initializations left: nothing to close, so refuse.
        if (!victim) break;
        this.sessions.delete(victim.id);
        evicted.push(victim);
      }
    }
    const full =
      this.sessions.size + this.pending >= this.maxSessions ||
      (userKey !== undefined && this.userCount(userKey) >= this.maxSessionsPerUser);
    if (!full) this.reserve(userKey);
    await Promise.all(evicted.map((s) => this.closeTransport(s.transport)));
    return full ? undefined : this.admission(userKey);
  }

  /** Close every session whose last request ended over the idle timeout ago. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const idle = [...this.sessions.values()].filter((s) => s.openRequests === 0 && s.lastActivityAt <= cutoff);
    for (const s of idle) this.sessions.delete(s.id);
    await Promise.all(idle.map((s) => this.closeTransport(s.transport)));
  }

  /** Stop the sweep and close every session. For server shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopSweep?.();
    this.stopSweep = undefined;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => this.closeTransport(s.transport)));
  }

  private admission(userKey: string | undefined): Admission {
    let transport: StreamableHTTPServerTransport | undefined;
    let owner: string | undefined;
    let release = (): void => {};
    let reserved = true;
    let committed = false;
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    const unreserve = (): void => {
      if (!reserved) return;
      reserved = false;
      this.unreserve(userKey);
    };

    return {
      bind: (t, o, r) => {
        transport = t;
        owner = o;
        release = r;
        t.onclose = () => {
          const sid = t.sessionId;
          // Evicted or swept sessions are already out of the map; a newer
          // session never reuses an id, so this can't remove the wrong one.
          if (sid) this.sessions.delete(sid);
          unreserve();
          releaseOnce();
          this.stopSweepWhenEmpty();
        };
      },
      commit: (sessionId) => {
        if (!transport || !reserved) return;
        unreserve();
        committed = true;
        if (this.closed) {
          // Shutdown began while this was initializing: don't outlive it.
          void this.closeTransport(transport);
          return;
        }
        this.sessions.set(sessionId, {
          id: sessionId,
          transport,
          owner,
          userKey,
          lastActivityAt: this.now(),
          openRequests: 0,
        });
        this.startSweep();
      },
      cancel: () => {
        unreserve();
        // A committed session releases through its transport's onclose.
        if (!committed) releaseOnce();
      },
    };
  }

  private userCount(userKey: string): number {
    let n = this.pendingByUser.get(userKey) ?? 0;
    for (const s of this.sessions.values()) if (s.userKey === userKey) n++;
    return n;
  }

  /**
   * The user's session to close first: sessions with nothing in flight before
   * those with an open request (an SSE stream), then the least recently active.
   */
  private leastRecentlyUsed(userKey: string): Session | undefined {
    let best: Session | undefined;
    for (const s of this.sessions.values()) {
      if (s.userKey !== userKey) continue;
      if (
        !best ||
        (s.openRequests > 0) < (best.openRequests > 0) ||
        ((s.openRequests > 0) === (best.openRequests > 0) && s.lastActivityAt < best.lastActivityAt)
      ) {
        best = s;
      }
    }
    return best;
  }

  private reserve(userKey: string | undefined): void {
    this.pending++;
    if (userKey !== undefined) this.pendingByUser.set(userKey, (this.pendingByUser.get(userKey) ?? 0) + 1);
  }

  private unreserve(userKey: string | undefined): void {
    this.pending--;
    if (userKey === undefined) return;
    const left = (this.pendingByUser.get(userKey) ?? 1) - 1;
    if (left > 0) this.pendingByUser.set(userKey, left);
    else this.pendingByUser.delete(userKey);
  }

  /** Close the transport of a session already removed from the map; its onclose releases the rest. */
  private async closeTransport(transport: StreamableHTTPServerTransport): Promise<void> {
    try {
      await transport.close();
    } catch {
      console.error('[Session] error while closing a session');
    }
  }

  private startSweep(): void {
    if (this.stopSweep || this.closed) return;
    const interval = Math.max(1, Math.min(MAX_SWEEP_INTERVAL_MS, Math.floor(this.idleTimeoutMs / 2)));
    this.stopSweep = this.schedule(() => void this.sweep(), interval);
  }

  /** No sessions: no need for a timer until the next one registers. */
  private stopSweepWhenEmpty(): void {
    if (this.sessions.size > 0 || !this.stopSweep) return;
    this.stopSweep();
    this.stopSweep = undefined;
  }
}
