/**
 * Audit Log Tool
 *
 * View the audit log (#60): every write tool call and how it ended, including
 * refused ones, one row per item of a bulk call, and every revocation of an
 * MCP connection.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import {
  AUDIT_OPERATIONS,
  AUDIT_OUTCOMES,
  AUDIT_RESOURCE_TYPES,
  AUDIT_REVOCATION_OUTCOMES,
  AUDIT_REVOKE_OPERATION,
  AUDIT_WRITE_OUTCOMES,
  type AuditQuery,
  type AuditRecord,
} from '../../storage/audit-rows.js';
import { sanitizeString } from '../../utils/sanitize.js';

/**
 * Every write outcome but success: what `success: false` selects. A
 * revocation is not a write attempt, so neither `success` value selects one.
 */
const FAILED_OUTCOMES = AUDIT_WRITE_OUTCOMES.filter((o) => o !== 'success');
const REVOCATION_OUTCOMES: readonly string[] = AUDIT_REVOCATION_OUTCOMES;

// Input schema. The enums are the audit log's own vocabulary, so every value
// the log records can be filtered on.
const inputSchema = z
  .object({
    operation: z.enum(AUDIT_OPERATIONS).optional().describe('Filter by operation type'),
    resource_type: z.enum(AUDIT_RESOURCE_TYPES).optional().describe('Filter by resource type'),
    outcome: z.enum(AUDIT_OUTCOMES).optional().describe('Filter by outcome'),
    success: z.boolean().optional().describe('Filter write attempts by success/failure'),
    all_clients: z.boolean().optional().describe("Show the entries of all of this user's connections"),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum entries to return (default 20)'),
    summary_only: z.boolean().optional().describe('Return only summary statistics'),
  })
  .strict();

// Tool definition
export const auditLogTool: Tool = {
  name: 'ynab_audit_log',
  description: `View the audit log: write attempts and revoked connections.

Use when the user asks:
- "What changes have been made?"
- "Show me the audit log"
- "What transactions were created?"
- "Were there any failed or refused operations?"
- "Which client made this change?"
- "Was any of my connections revoked?" (use all_clients: true)

Shows every create, update, delete and move attempt, newest first, with the tool, the resource id, the calling client and request, and how it ended: success, denied_read_only (the server is read-only), denied_scope (this connection or the YNAB grant is read-only), denied_write_limit (the hourly write cap, first refusal of each episode) or error. A bulk call has one entry per transaction it saved, all with the same request_id (a refused or failed one has a single entry). An audit_suppressed entry means more refused writes came in that hour than the log records (20 per user); the ones after it are missing.

On a server with OAuth it also records each revoked connection (operation revoke, resource_type grant or client): revoked (the user or the client revoked it), revoked_reuse (a used refresh token or code was presented again, or by another client, so the connection was ended) or revoked_replay (the same one was used twice at once). Issuing and refreshing tokens is not recorded.

Entries hold ids only, never amounts, names, memos or tokens. On a server with OAuth, only this connection's (MCP client's) entries are shown by default; all_clients: true shows every connection of the same user (never another user's). In HTTP mode with durable storage the log survives restarts and entries are kept for the operator's retention period (90 days by default); on stdio it is kept in memory (newest 1000 entries).`,
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
        description: 'Filter write attempts by success/failure (false: every write outcome but success; never a revocation)',
      },
      all_clients: {
        type: 'boolean',
        description:
          "Show the entries of all of this user's connections (MCP clients), not only this one's. Never shows another user's. No effect without OAuth.",
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
  revocation_count: number;
  by_outcome: Record<string, number>;
} {
  let total = 0;
  let revocations = 0;
  for (const [outcome, n] of Object.entries(counts)) {
    total += n;
    if (REVOCATION_OUTCOMES.includes(outcome)) revocations += n;
  }
  const success = counts['success'] ?? 0;
  return {
    total_operations: total,
    success_count: success,
    failure_count: total - success - revocations,
    revocation_count: revocations,
    by_outcome: counts,
  };
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
    // A revocation is not a write attempt: it neither succeeded nor failed.
    success: e.operation === AUDIT_REVOKE_OPERATION ? null : e.outcome === 'success',
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

  // The calling client's entries only (oauth mode; #60), unless all_clients
  // asks for every client of the same user. The user filter is the log's own
  // (AuditLog.list and counts are bound to the caller's user), so no option
  // reaches another user's rows. A read-only grant may use it: it reads the
  // same user's log. Without a client id (stdio, header mode) the user is
  // the only caller and the option changes nothing.
  const scope: AuditQuery =
    auditLog.clientId === undefined || validated.all_clients === true ? {} : { clientId: auditLog.clientId };
  const query: AuditQuery = { ...scope };
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
        ...(validated.all_clients === true ? { all_clients: true } : {}),
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
  // The caller's whole log's totals for context (unfiltered).
  const summary = summarize(await auditLog.counts(scope));

  return JSON.stringify(
    {
      entries,
      count: entries.length,
      ...(validated.all_clients === true ? { all_clients: true } : {}),
      summary,

      message: entries.length === 0 ? 'No matching audit log entries found' : `Showing ${entries.length} most recent entries`,
    },
    null,
    2
  );
}
