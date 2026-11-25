/**
 * Rate Limit Status Tool
 *
 * Returns the current API rate limit status.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeString } from '../../utils/sanitize.js';
import { BREAKER_STATES } from '../../services/circuit-breaker.js';
import { toOutputSchema } from '../output-schema.js';

// Input schema (strict - rejects unexpected properties)
const inputSchema = z.object({}).strict();

const count = () => z.number().int();

/** What the tool returns (#45; rules in ../output-schema.ts). Nulls here are reported on purpose. */
export const rateLimitStatusOutputSchema = z.object({
  status: z.enum(['healthy', 'warning', 'critical']),
  message: z.string(),
  ynab_exhausted: z
    .object({
      active: z.boolean(),
      exhausted_at: z.string(),
      resets_at: z.string(),
      retry_after_seconds: count(),
    })
    .nullable()
    .describe('Null when YNAB has not answered 429 within the window'),
  rate_limit: z.object({
    available_requests: count(),
    total_limit: count(),
    used_requests: count(),
    percent_used: z.number(),
    store: z
      .enum(['memory', 'postgres'])
      .describe('memory: this process holds the budget; postgres: every replica shares it (RATE_LIMIT_STORE)'),
  }),
  usage: z.object({
    requests_last_hour: count(),
    rejected_last_hour: count(),
    max_wait_ms: count(),
  }),
  client_usage: z
    .object({
      client_id: z.string().nullable().describe('Null on stdio and in header mode'),
      requests_last_hour: count(),
      rejected_last_hour: count(),
    })
    .nullable()
    .describe('Null when per-client usage is not tracked'),
  upstream: z.object({
    circuit: z.enum(BREAKER_STATES),
    consecutive_failures: count(),
    retry_after_seconds: count().optional(),
  }),
  cache: z.object({ bytes: count(), max_bytes: count() }).nullable(),
  timing: z.object({
    can_make_request_now: z.boolean(),
    wait_time_seconds: count(),
    full_reset_minutes: count(),
  }),
  recommendations: z.array(z.string()),
});
export type RateLimitStatusOutput = z.output<typeof rateLimitStatusOutputSchema>;

// Tool definition
export const rateLimitStatusTool: Tool = {
  name: 'ynab_rate_limit_status',
  description: `Check the current YNAB API rate limit status.

Use when you need to:
- Check how many API requests are available
- See if rate limiting might affect operations
- Plan large operations that require many API calls

YNAB allows 200 requests per hour. This server uses 180 as a safety margin. If YNAB itself has answered 429 (too many requests), ynab_exhausted shows when that happened and when requests are allowed again; until then requests fail fast.

When the budget is used up, tool calls fail at once with a rate_limited error and retry_after_seconds (they wait at most max_wait_ms for a token, and only one call waits at a time). In HTTP mode each user has their own budget, shared by all of that user's clients; usage shows this user's requests and refusals over the last hour, and client_usage the calling client's share of them (client_id is null on stdio and in header mode, where there is one caller). rate_limit.store is memory when this server process holds the budget, postgres when every replica shares it (then usage and client_usage count this replica's requests only).

upstream.circuit is the circuit breaker: after 20 consecutive YNAB 5xx responses or timeouts within 60 seconds it opens for 30 seconds, and tool calls fail at once with an upstream_unavailable error and retry_after_seconds. cache shows the bytes this user's cache holds against its budget (8 MiB).`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  outputSchema: toOutputSchema(rateLimitStatusOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_rate_limit_status tool.
 */
export async function handleRateLimitStatus(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<RateLimitStatusOutput> {
  // Validate input (ensures no unexpected properties)
  inputSchema.parse(args);

  await client.refreshRateLimitStatus();
  const status = client.getRateLimitStatus();
  const upstream = client.getUpstreamStatus();
  const clientUsage = client.getClientUsage();

  // Calculate human-readable times
  const circuitRetrySeconds = upstream.circuit ? Math.ceil(upstream.circuit.retryAfterMs / 1000) : 0;
  const waitTimeSeconds = Math.max(Math.ceil(status.waitTimeMs / 1000), circuitRetrySeconds);
  const resetTimeMinutes = Math.ceil(status.resetTimeMs / 60000);

  // Determine status level
  let statusLevel: 'healthy' | 'warning' | 'critical';
  let statusMessage: string;

  if (status.percentUsed < 50) {
    statusLevel = 'healthy';
    statusMessage = 'Plenty of API quota available';
  } else if (status.percentUsed < 80) {
    statusLevel = 'warning';
    statusMessage = 'API quota is being consumed - consider spacing out requests';
  } else {
    statusLevel = 'critical';
    statusMessage = 'API quota is low - limit requests to essential operations';
  }

  // YNAB answered 429 to this user's requests: reported until the window passes
  // (active) and afterwards as history (active false).
  const ynab = status.ynabExhausted;
  const ynabExhausted = ynab
    ? {
        active: ynab.active,
        exhausted_at: new Date(ynab.exhaustedAtMs).toISOString(),
        resets_at: new Date(ynab.untilMs).toISOString(),
        retry_after_seconds: Math.ceil(ynab.retryAfterMs / 1000),
      }
    : null;
  if (ynab?.active) {
    statusLevel = 'critical';
    statusMessage = 'YNAB rate-limited this account (429); requests are paused until it resets';
  }

  return {
    status: statusLevel,
    message: statusMessage,
    ynab_exhausted: ynabExhausted,
    rate_limit: {
      available_requests: status.available,
      total_limit: status.limit,
      used_requests: status.used,
      percent_used: status.percentUsed,
      // memory: this process's budget; postgres: shared by every replica (#67c).
      store: status.store,
    },
    usage: {
      requests_last_hour: status.sentLastHour,
      rejected_last_hour: status.rejectedLastHour,
      max_wait_ms: status.maxWaitMs,
    },
    // The calling client's share of the user's usage (#58).
    client_usage: clientUsage
      ? {
          client_id: clientUsage.clientId === undefined ? null : sanitizeString(clientUsage.clientId, 200),
          requests_last_hour: clientUsage.sentLastHour,
          rejected_last_hour: clientUsage.rejectedLastHour,
        }
      : null,
    // The circuit breaker (#58): after repeated YNAB failures or timeouts, calls fail fast for a while.
    upstream: {
      circuit: upstream.circuit?.state ?? 'closed',
      consecutive_failures: upstream.circuit?.consecutiveFailures ?? 0,
      ...(upstream.circuit && upstream.circuit.retryAfterMs > 0
        ? { retry_after_seconds: Math.ceil(upstream.circuit.retryAfterMs / 1000) }
        : {}),
    },
    cache: upstream.cache
      ? { bytes: upstream.cache.bytes, max_bytes: upstream.cache.maxBytes }
      : null,
    timing: {
      can_make_request_now: status.canMakeRequest && upstream.circuit?.state !== 'open',
      wait_time_seconds: waitTimeSeconds,
      full_reset_minutes: resetTimeMinutes,
    },
    recommendations:
      status.percentUsed > 50
        ? [
            'Use filtered queries instead of fetching all data',
            'Rely on cached data when possible',
            'Batch operations when available',
          ]
        : [],
  };
}
