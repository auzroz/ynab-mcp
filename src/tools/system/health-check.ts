/**
 * Health Check Tool
 *
 * Verifies the YNAB API connection and server status.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeErrorMessage } from '../../utils/sanitize.js';

/**
 * Input schema for health check tool.
 * Accepts an empty object (no parameters required).
 */
const inputSchema = z.object({}).strict();

// Tool definition
export const healthCheckTool: Tool = {
  name: 'ynab_health_check',
  description: `Check the health of the YNAB MCP server and API connection.

Use when:
- Troubleshooting connection issues
- Verifying the server is configured correctly
- Checking if the YNAB API is accessible

Returns server status, API connectivity, and configuration details.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// Handler function
export async function handleHealthCheck(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  // Validate inputs (rejects unexpected properties)
  inputSchema.parse(args);

  const startTime = Date.now();
  const checks: {
    name: string;
    status: 'pass' | 'fail';
    duration_ms?: number;
    message?: string;
    error?: string;
  }[] = [];

  // Check 1: Rate limiter status
  const rateLimitStatus = client.getRateLimitStatus();
  checks.push({
    name: 'rate_limiter',
    status: rateLimitStatus.canMakeRequest ? 'pass' : 'fail',
    message: rateLimitStatus.canMakeRequest
      ? `${rateLimitStatus.available}/${rateLimitStatus.limit} requests available`
      : 'Rate limit exhausted',
  });

  // Check 2: API connectivity (attempt to get user info)
  const apiCheckStart = Date.now();
  try {
    await client.getUser();
    const apiCheckDuration = Date.now() - apiCheckStart;
    checks.push({
      name: 'api_connectivity',
      status: 'pass',
      duration_ms: apiCheckDuration,
      message: 'Connected successfully',
    });
  } catch (err) {
    const apiCheckDuration = Date.now() - apiCheckStart;
    // Log sanitized error internally for debugging (not exposed in response)
    console.error('Health check API connectivity failed:', sanitizeErrorMessage(err));
    checks.push({
      name: 'api_connectivity',
      status: 'fail',
      duration_ms: apiCheckDuration,
      error: 'Failed to connect to YNAB API',
    });
  }

  // Check 3: Read-only mode status
  checks.push({
    name: 'write_operations',
    status: 'pass', // Not a failure, just informational
    message: client.isReadOnly()
      ? 'Server is in READ-ONLY mode (write operations disabled)'
      : 'Write operations are ENABLED',
  });

  // Check 4: Default budget configuration
  const defaultBudgetId = client.getDefaultBudgetId();
  // Mask UUID to avoid exposing internal IDs (show first 4 and last 4 chars)
  const maskedBudgetId = defaultBudgetId.length > 12
    ? `${defaultBudgetId.slice(0, 4)}...${defaultBudgetId.slice(-4)}`
    : defaultBudgetId;
  checks.push({
    name: 'default_budget',
    status: 'pass',
    message:
      defaultBudgetId === 'last-used'
        ? 'Using "last-used" budget (no specific default set)'
        : `Default budget configured (${maskedBudgetId})`,
  });

  // Calculate overall status
  const failedChecks = checks.filter((c) => c.status === 'fail');
  const overallStatus = failedChecks.length === 0 ? 'healthy' : 'unhealthy';
  const totalDuration = Date.now() - startTime;

  return JSON.stringify(
    {
      status: overallStatus,
      message:
        overallStatus === 'healthy'
          ? 'All systems operational'
          : `${failedChecks.length} check(s) failed`,
      checks,
      summary: {
        total_checks: checks.length,
        passed: checks.filter((c) => c.status === 'pass').length,
        failed: failedChecks.length,
        total_duration_ms: totalDuration,
      },
      timestamp: new Date().toISOString(),
    },
    null,
    2
  );
}
