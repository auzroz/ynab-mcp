/**
 * Audit Log Tool
 *
 * View the audit log of write operations.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getAuditLog } from '../../services/audit-log.js';

// Input schema
const inputSchema = z.object({
  operation: z
    .enum(['create', 'update', 'delete'])
    .optional()
    .describe('Filter by operation type'),
  resource_type: z
    .enum(['transaction', 'account', 'category'])
    .optional()
    .describe('Filter by resource type'),
  success: z.boolean().optional().describe('Filter by success/failure'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum entries to return (default 20)'),
  summary_only: z
    .boolean()
    .optional()
    .describe('Return only summary statistics'),
}).strict();

// Tool definition
export const auditLogTool: Tool = {
  name: 'ynab_audit_log',
  description: `View the audit log of write operations.

Use when the user asks:
- "What changes have been made?"
- "Show me the audit log"
- "What transactions were created?"
- "Were there any failed operations?"

Shows all create, update, and delete operations with timestamps.`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['create', 'update', 'delete'],
        description: 'Filter by operation type',
      },
      resource_type: {
        type: 'string',
        enum: ['transaction', 'account', 'category'],
        description: 'Filter by resource type',
      },
      success: {
        type: 'boolean',
        description: 'Filter by success/failure',
      },
      limit: {
        type: 'integer',
        description: 'Maximum entries to return (default 20)',
        minimum: 1,
        maximum: 100,
      },
      summary_only: {
        type: 'boolean',
        description: 'Return only summary statistics',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

// Handler function
/**
 * Handler for the ynab_audit_log tool.
 * Note: client param intentionally omitted; this tool only uses the local AuditLog service.
 */
export async function handleAuditLog(
  args: Record<string, unknown>
): Promise<string> {
  const validated = inputSchema.parse(args);
  const auditLog = getAuditLog();

  if (validated.summary_only) {
    const summary = auditLog.getSummary();
    // Normalize to snake_case to match full response schema
    const summaryOut = {
      total_operations: summary.totalOperations,
      success_count: summary.successCount,
      failure_count: summary.failureCount,
    };
    return JSON.stringify(
      {
        summary: summaryOut,
        message:
          summaryOut.total_operations === 0
            ? 'No write operations have been performed yet'
            : `${summaryOut.total_operations} operations logged`,
      },
      null,
      2
    );
  }

  const filterOptions: {
    operation?: string;
    resourceType?: string;
    success?: boolean;
    limit: number;
  } = {
    limit: validated.limit ?? 20,
  };

  if (validated.operation !== undefined) filterOptions.operation = validated.operation;
  if (validated.resource_type !== undefined) filterOptions.resourceType = validated.resource_type;
  if (validated.success !== undefined) filterOptions.success = validated.success;

  const entries = auditLog.getFiltered(filterOptions);

  const summary = auditLog.getSummary();

  return JSON.stringify(
    {
      entries,
      count: entries.length,
      summary: {
        total_operations: summary.totalOperations,
        success_count: summary.successCount,
        failure_count: summary.failureCount,
      },
      message:
        entries.length === 0
          ? 'No matching audit log entries found'
          : `Showing ${entries.length} most recent entries`,
    },
    null,
    2
  );
}
