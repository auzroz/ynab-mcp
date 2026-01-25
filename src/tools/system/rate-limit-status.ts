/**
 * Rate Limit Status Tool
 *
 * Returns the current API rate limit status.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
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

YNAB allows 200 requests per hour. This server uses 180 as a safety margin.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// Handler function
export async function handleRateLimitStatus(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  // Validate input (ensures no unexpected properties)
  inputSchema.parse(args);

  const status = client.getRateLimitStatus();

  // Calculate human-readable times
  const waitTimeSeconds = Math.ceil(status.waitTimeMs / 1000);
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

  return JSON.stringify(
    {
      status: statusLevel,
      message: statusMessage,
      rate_limit: {
        available_requests: status.available,
        total_limit: status.limit,
        used_requests: status.used,
        percent_used: status.percentUsed,
      },
      timing: {
        can_make_request_now: status.canMakeRequest,
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
