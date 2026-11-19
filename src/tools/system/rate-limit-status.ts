/**
 * Rate Limit Status Tool
 *
 * Returns the current API rate limit status.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';

// Input schema (strict - rejects unexpected properties)
const inputSchema = z.object({}).strict();

// Tool definition
export const rateLimitStatusTool: Tool = {
  name: 'ynab_rate_limit_status',
  description: `Check the current YNAB API rate limit status.

Use when you need to:
- Check how many API requests are available
- See if rate limiting might affect operations
- Plan large operations that require many API calls

YNAB allows 200 requests per hour. This server uses 180 as a safety margin. If YNAB itself has answered 429 (too many requests), ynab_exhausted shows when that happened and when requests are allowed again; until then requests fail fast.

When the budget is used up, tool calls fail at once with a rate_limited error and retry_after_seconds (they wait at most max_wait_ms for a token, and only one call waits at a time). In HTTP mode each user has their own budget, shared by that user's sessions; usage shows this user's requests and refusals over the last hour.

upstream.circuit is the circuit breaker: after 20 consecutive YNAB 5xx responses or timeouts within 60 seconds it opens for 30 seconds, and tool calls fail at once with an upstream_unavailable error and retry_after_seconds. cache shows the bytes this user's cache holds against its budget (8 MiB).`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// Handler function
/**
 * Handler for the ynab_rate_limit_status tool.
 */
export async function handleRateLimitStatus(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  // Validate input (ensures no unexpected properties)
  inputSchema.parse(args);

  const status = client.getRateLimitStatus();
  const upstream = client.getUpstreamStatus();

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

  return JSON.stringify(
    {
      status: statusLevel,
      message: statusMessage,
      ynab_exhausted: ynabExhausted,
      rate_limit: {
        available_requests: status.available,
        total_limit: status.limit,
        used_requests: status.used,
        percent_used: status.percentUsed,
      },
      usage: {
        requests_last_hour: status.sentLastHour,
        rejected_last_hour: status.rejectedLastHour,
        max_wait_ms: status.maxWaitMs,
      },
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
    },
    null,
    2
  );
}
