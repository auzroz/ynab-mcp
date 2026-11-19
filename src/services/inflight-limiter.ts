/**
 * Concurrency bounds for stateless /mcp (ADR-0001 D5, D6).
 *
 * `InflightLimiter` counts the requests in flight per user, per (client,
 * user) and across the process. A request past any of the three caps is
 * refused (429 with `Retry-After: 1`, answered by src/http.ts) before any
 * storage read or server instance. The per-(client, user) cap keeps one
 * client from taking all of a user's slots (ABUSE-22); the process-wide cap
 * bounds header mode, where any non-empty YNAB token is a new "user".
 *
 * `RequestLifetime` decides when a request gives back what it holds (its
 * in-flight slot and its UserRegistry lease): once its response has closed
 * AND every piece of work it started has settled. A response closes on every
 * path (finished, client gone, request ceiling), but the YNAB work behind a
 * timed-out or abandoned tool call keeps running; releasing on close alone
 * would let the registry evict components still in use and let a client
 * stack up abandoned work past the caps.
 */

/** The three caps (MCP_MAX_INFLIGHT_PER_USER, MCP_MAX_INFLIGHT_PER_CLIENT, MCP_MAX_INFLIGHT). */
export interface InflightCaps {
  readonly perUser: number;
  readonly perClient: number;
  readonly total: number;
}

/** Which cap refused a request (for tests and the operator's log; never sent to the client). */
export type InflightRefusal = 'per-user' | 'per-client' | 'total';

/** A taken slot; `release` is idempotent. */
export interface InflightSlot {
  release(): void;
}

export class InflightLimiter {
  private readonly perUser = new Map<string, number>();
  private readonly perClient = new Map<string, number>();
  private total = 0;

  constructor(private readonly caps: InflightCaps) {}

  /**
   * Take a slot for a request of `userKey` through `clientId`, or report the
   * cap that refuses it. `clientId` is undefined in header mode, which has no
   * client identity: only the per-user and process-wide caps apply there.
   */
  acquire(userKey: string, clientId: string | undefined): InflightSlot | InflightRefusal {
    const clientKey = clientId === undefined ? undefined : JSON.stringify([clientId, userKey]);
    if (this.total >= this.caps.total) return 'total';
    if ((this.perUser.get(userKey) ?? 0) >= this.caps.perUser) return 'per-user';
    if (clientKey !== undefined && (this.perClient.get(clientKey) ?? 0) >= this.caps.perClient) return 'per-client';

    this.total++;
    increment(this.perUser, userKey);
    if (clientKey !== undefined) increment(this.perClient, clientKey);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.total--;
        decrement(this.perUser, userKey);
        if (clientKey !== undefined) decrement(this.perClient, clientKey);
      },
    };
  }

  /** Requests in flight: across the process, or for one user. */
  inflight(userKey?: string): number {
    return userKey === undefined ? this.total : (this.perUser.get(userKey) ?? 0);
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const n = (map.get(key) ?? 0) - 1;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

/**
 * One request's holds and started work (D5). Holds (`hold`) are released, in
 * reverse order, once `close()` has been called and every `run()` has
 * settled. Once the response has closed nothing new starts: `run` refuses,
 * and `hold` releases what it is given at once, so nothing a stage takes
 * after a timeout or a disconnect is kept.
 */
export class RequestLifetime {
  private closed = false;
  private released = false;
  private pending = 0;
  private readonly holds: Array<() => void> = [];

  /** @param deadline Absolute time (epoch ms) at which the request ceiling fires. */
  constructor(readonly deadline: number) {}

  /** Whether the response has closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether the holds have been released (closed, and all started work settled). */
  get isReleased(): boolean {
    return this.released;
  }

  /** Work started and not yet settled. */
  get pendingWork(): number {
    return this.pending;
  }

  /**
   * Keep `release` until the request is done with. Returns false, having
   * called `release` already, when the response has closed: the caller must
   * stop.
   */
  hold(release: () => void): boolean {
    if (this.closed) {
      release();
      return false;
    }
    this.holds.push(release);
    return true;
  }

  /**
   * Start `work` as part of the request: its holds are kept until it settles,
   * even past the response. Undefined, without starting it, once the response
   * has closed.
   */
  run<T>(work: () => Promise<T>): Promise<T> | undefined {
    if (this.closed) return undefined;
    this.pending++;
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (error) {
      promise = Promise.reject(error);
    }
    const settle = (): void => {
      this.pending--;
      this.releaseIfDone();
    };
    // Settling is observed on a branch of its own (rejections handled), so the
    // caller still gets the work's own promise to await or race.
    promise.then(settle, settle);
    return promise;
  }

  /** The response has closed (finished, aborted or ended at the ceiling). Idempotent. */
  close(): void {
    this.closed = true;
    this.releaseIfDone();
  }

  private releaseIfDone(): void {
    if (!this.closed || this.pending > 0 || this.released) return;
    this.released = true;
    for (const release of this.holds.splice(0).reverse()) release();
  }
}
