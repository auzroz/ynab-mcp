/**
 * Per-client attribution of one user's YNAB requests (#58).
 *
 * The rate limiter is per user (YNAB limits per token), so every MCP client
 * of a user draws on one budget. This records which client sent each request
 * and each refusal over the last hour, so ynab_rate_limit_status can show the
 * calling client's share beside the user's total. It is a report only: it
 * limits nothing.
 *
 * Kept in the user's components (in process, like the limiter). Bounded: a
 * client's sent requests are bounded by the user's limiter, its refusals are
 * capped, and past `maxClients` the least recently active client is dropped.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Cap on remembered refusals per client, as the limiter's. */
const MAX_TRACKED_REJECTIONS = 1000;
/** Default bound on clients tracked per user. */
export const DEFAULT_MAX_TRACKED_CLIENTS = 50;
/** The key of requests with no MCP client (stdio, header mode). */
export const NO_CLIENT = '';

interface Counts {
  sentAt: number[];
  rejectedAt: number[];
}

export interface ClientUsageStatus {
  /** Requests this client sent in the last hour. */
  sentLastHour: number;
  /** Calls of this client the rate limiter refused in the last hour (capped). */
  rejectedLastHour: number;
}

export class ClientUsage {
  // Map order is recency: a client is moved to the end whenever it is active.
  private readonly clients = new Map<string, Counts>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxClients: number = DEFAULT_MAX_TRACKED_CLIENTS
  ) {}

  /** A request of `client` was sent (it took a rate-limit token). */
  sent(client: string): void {
    const counts = this.touch(client);
    const now = this.now();
    prune(counts.sentAt, now);
    counts.sentAt.push(now);
  }

  /** A request `sent()` counted was not sent after all (its token went back). */
  unsent(client: string): void {
    this.clients.get(client)?.sentAt.pop();
  }

  /** The rate limiter refused a call of `client`. */
  rejected(client: string): void {
    const counts = this.touch(client);
    const now = this.now();
    prune(counts.rejectedAt, now);
    if (counts.rejectedAt.length < MAX_TRACKED_REJECTIONS) counts.rejectedAt.push(now);
  }

  status(client: string): ClientUsageStatus {
    const counts = this.clients.get(client);
    if (counts === undefined) return { sentLastHour: 0, rejectedLastHour: 0 };
    const now = this.now();
    prune(counts.sentAt, now);
    prune(counts.rejectedAt, now);
    return { sentLastHour: counts.sentAt.length, rejectedLastHour: counts.rejectedAt.length };
  }

  /** Clients tracked (tests). */
  get size(): number {
    return this.clients.size;
  }

  private touch(client: string): Counts {
    let counts = this.clients.get(client);
    if (counts === undefined) {
      counts = { sentAt: [], rejectedAt: [] };
    } else {
      this.clients.delete(client);
    }
    this.clients.set(client, counts);
    while (this.clients.size > this.maxClients) {
      const oldest = this.clients.keys().next().value as string;
      this.clients.delete(oldest);
    }
    return counts;
  }
}

function prune(times: number[], now: number): void {
  const cutoff = now - HOUR_MS;
  let i = 0;
  while (i < times.length && (times[i] as number) <= cutoff) i++;
  if (i > 0) times.splice(0, i);
}
