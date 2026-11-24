/**
 * Audit Log Tool
 *
 * View the audit log of write attempts (#60a): every write tool call and how
 * it ended, including refused ones.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import {
  AUDIT_OPERATIONS,
  AUDIT_OUTCOMES,
  AUDIT_RESOURCE_TYPES,
  type AuditQuery,
  type AuditRecord,
} from '../../storage/audit-rows.js';
import { sanitizeString } from '../../utils/sanitize.js';

/** Every outcome but success: what `success: false` selects. */
const FAILED_OUTCOMES = AUDIT_OUTCOMES.filter((o) => o !== 'success');

// Input schema. The enums are the audit log's own vocabulary, so every value
// the log records can be filtered on.
const inputSchema = z
  .object({
    operation: z.enum(AUDIT_OPERATIONS).optional().describe('Filter by operation type'),
    resource_type: z.enum(AUDIT_RESOURCE_TYPES).optional().describe('Filter by resource type'),
    outcome: z.enum(AUDIT_OUTCOMES).optional().describe('Filter by outcome'),
    success: z.boolean().optional().describe('Filter by success/failure'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum entries to return (default 20)'),
    summary_only: z.boolean().optional().describe('Return only summary statistics'),
  })
  .strict();

// Tool definition
export const auditLogTool: Tool = {
  name: 'ynab_audit_log',
  description: `View the audit log of write attempts.

Use when the user asks:
- "What changes have been made?"
- "Show me the audit log"
- "What transactions were created?"
- "Were there any failed or refused operations?"
- "Which client made this change?"

Shows every create, update, delete and move attempt, newest first, with the tool, the resource id, the calling client and request, and how it ended: success, denied_read_only (the server is read-only), denied_scope (this connection or the YNAB grant is read-only), denied_write_limit (the hourly write cap, first refusal of each episode) or error. Entries hold ids only, never amounts, names or memos. In HTTP mode with durable storage the log survives restarts; on stdio it is kept in memory (newest 1000 entries).`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [...AUDIT_OPERATIONS],
        description: 'Filter by operation type',
      },
      resource_type: {
        type: 'string',
        enum: [...AUDIT_RESOURCE_TYPES],
        description: 'Filter by resource type',
      },
      outcome: {
        type: 'string',
        enum: [...AUDIT_OUTCOMES],
        description: 'Filter by outcome',
      },
      success: {
        type: 'boolean',
        description: 'Filter by success/failure (false: every outcome but success)',
      },
      limit: {
        type: 'integer',
        description: 'Maximum entries to return (default 20)',
        minimum: 1,
        maximum: 100,
        default: 20,
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

/** Count totals from per-outcome counts. */
function summarize(counts: Record<string, number>): {
  total_operations: number;
  success_count: number;
  failure_count: number;
  by_outcome: Record<string, number>;
} {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  const success = counts['success'] ?? 0;
  return { total_operations: total, success_count: success, failure_count: total - success, by_outcome: counts };
}

/** An entry as the tool shows it (ids sanitized; they are ours or YNAB's, never user text). */
function present(e: AuditRecord): Record<string, unknown> {
  const text = (v: string | undefined): string | null => (v === undefined ? null : sanitizeString(v, 200));
  return {
    timestamp: new Date(e.ts).toISOString(),
    tool: text(e.tool),
    operation: text(e.operation),
    resource_type: text(e.resourceType),
    resource_id: text(e.resourceId),
    budget_id: text(e.budgetId),
    outcome: text(e.outcome),
    success: e.outcome === 'success',
    client_id: text(e.clientId),
    family_id: text(e.familyId),
    request_id: text(e.requestId),
  };
}

// Handler function
/**
 * Handler for the ynab_audit_log tool. Reads the caller's own user's log
 * through the client (per user, per request in HTTP mode).
 */
export async function handleAuditLog(args: Record<string, unknown>, client: YnabClient): Promise<string> {
  const validated = inputSchema.parse(args);
  const auditLog = client.getAuditLog();

  const query: AuditQuery = {};
  if (validated.operation !== undefined) query.operation = validated.operation;
  if (validated.resource_type !== undefined) query.resourceType = validated.resource_type;
  let outcomes: readonly string[] | undefined;
  if (validated.success !== undefined) outcomes = validated.success ? ['success'] : FAILED_OUTCOMES;
  if (validated.outcome !== undefined) {
    outcomes = outcomes === undefined || outcomes.includes(validated.outcome) ? [validated.outcome] : [];
  }
  if (outcomes !== undefined) query.outcomes = outcomes;

  const hasFilters =
    validated.operation !== undefined ||
    validated.resource_type !== undefined ||
    validated.outcome !== undefined ||
    validated.success !== undefined;

  if (validated.summary_only) {
    const summary = summarize(await auditLog.counts(query));
    return JSON.stringify(
      {
        summary,
        ...(hasFilters ? { filters_applied: true } : {}),
        message:
          summary.total_operations === 0
            ? hasFilters
              ? 'No matching audit log entries found'
              : 'No write operations have been attempted yet'
            : `${summary.total_operations} operations logged${hasFilters ? ' (filtered)' : ''}`,
      },
      null,
      2
    );
  }

  const entries = (await auditLog.list(query, validated.limit ?? 20)).map(present);
  // The whole log's totals for context (unfiltered).
  const summary = summarize(await auditLog.counts({}));

  return JSON.stringify(
    {
      entries,
      count: entries.length,
      summary,
      message: entries.length === 0 ? 'No matching audit log entries found' : `Showing ${entries.length} most recent entries`,
    },
    null,
    2
  );
}
