/**
 * Audit Log Tool Tests (#60a: the durable, attributable log).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleAuditLog, auditLogTool } from '../../../../src/tools/system/audit-log.js';
import { AuditLog } from '../../../../src/services/audit-log.js';
import { YnabClient } from '../../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../../src/services/rate-limiter.js';
import { Cache } from '../../../../src/services/cache.js';
import {
  AUDIT_OPERATIONS,
  AUDIT_OUTCOMES,
  AUDIT_RESOURCE_TYPES,
  MemoryAuditStore,
} from '../../../../src/storage/audit-rows.js';
import { WRITE_TOOL_AUDIT_TARGETS } from '../../../../src/tools/audit-targets.js';

interface Entry {
  operation: string;
  resource_type: string;
  outcome: string;
  success: boolean;
}

let audit: AuditLog;
let client: YnabClient;

async function seedEntries(): Promise<void> {
  await audit.record({ operation: 'create', tool: 'ynab_create_transaction', budgetId: 'budget-1', resourceType: 'transaction', outcome: 'success' });
  await audit.record({ operation: 'update', tool: 'ynab_update_transaction', budgetId: 'budget-1', resourceType: 'transaction', outcome: 'success' });
  await audit.record({ operation: 'create', tool: 'ynab_create_account', budgetId: 'budget-2', resourceType: 'account', outcome: 'error' });
}

describe('handleAuditLog', () => {
  beforeEach(() => {
    // Silence the stderr [AUDIT] logging
    vi.spyOn(console, 'error').mockImplementation(() => {});
    audit = new AuditLog(new MemoryAuditStore(), { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', requestId: 'req-1' });
    client = new YnabClient('t', 'b', new RateLimiter(180), new Cache(300000), true, audit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a message when no operations have been performed', async () => {
    const parsed = JSON.parse(await handleAuditLog({}, client));
    expect(parsed.entries).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.message).toBe('No matching audit log entries found');
    expect(parsed.summary.total_operations).toBe(0);
  });

  it('returns full entries most-recent-first with global summary', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({}, client));
    expect(parsed.count).toBe(3);
    expect(parsed.entries[0]).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      tool: 'ynab_create_account',
      operation: 'create',
      resource_type: 'account',
      resource_id: null,
      budget_id: 'budget-2',
      outcome: 'error',
      success: false,
      client_id: 'client-a',
      family_id: 'grant-a',
      request_id: 'req-1',
    });
    expect(parsed.summary).toEqual({ total_operations: 3, success_count: 2, failure_count: 1, by_outcome: { success: 2, error: 1 } });
    expect(parsed.message).toContain('Showing 3');
  });

  it('filters by operation', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({ operation: 'create' }, client));
    expect(parsed.count).toBe(2);
    expect(parsed.entries.every((e: Entry) => e.operation === 'create')).toBe(true);
  });

  it('filters by resource_type and success', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({ resource_type: 'account', success: false }, client));
    expect(parsed.count).toBe(1);
    expect(parsed.entries[0].resource_type).toBe('account');
    expect(parsed.entries[0].success).toBe(false);
  });

  it('success: false covers refused writes too; outcome narrows to one', async () => {
    await seedEntries();
    await audit.record({ operation: 'delete', tool: 'ynab_delete_transaction', resourceType: 'transaction', outcome: 'denied_scope' });
    await audit.record({ operation: 'create', tool: 'ynab_create_payee', resourceType: 'payee', outcome: 'denied_write_limit' });
    const failed = JSON.parse(await handleAuditLog({ success: false }, client));
    expect(failed.entries.map((e: Entry) => e.outcome)).toEqual(['denied_write_limit', 'denied_scope', 'error']);
    const scope = JSON.parse(await handleAuditLog({ outcome: 'denied_scope' }, client));
    expect(scope.entries.map((e: Entry) => e.outcome)).toEqual(['denied_scope']);
    // Contradictory filters match nothing.
    expect(JSON.parse(await handleAuditLog({ outcome: 'success', success: false }, client)).count).toBe(0);
  });

  it('respects the limit parameter', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({ limit: 1 }, client));
    expect(parsed.count).toBe(1);
    expect(parsed.entries[0].tool).toBe('ynab_create_account');
  });

  it('returns a summary-only response without entries', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({ summary_only: true }, client));
    expect(parsed.entries).toBeUndefined();
    expect(parsed.summary.total_operations).toBe(3);
    expect(parsed.summary.success_count).toBe(2);
    expect(parsed.summary.failure_count).toBe(1);
    expect(parsed.filters_applied).toBeUndefined();
    expect(parsed.message).toContain('3 operations logged');
  });

  it('returns a filtered summary-only response with filters_applied flag', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({ summary_only: true, operation: 'update' }, client));
    expect(parsed.summary.total_operations).toBe(1);
    expect(parsed.filters_applied).toBe(true);
    expect(parsed.message).toContain('(filtered)');
  });

  it('returns no-match message for filtered summary with zero results', async () => {
    await seedEntries();
    const parsed = JSON.parse(await handleAuditLog({ summary_only: true, resource_type: 'category' }, client));
    expect(parsed.summary.total_operations).toBe(0);
    expect(parsed.message).toBe('No matching audit log entries found');
  });

  it('returns no-write message for unfiltered summary with zero entries', async () => {
    const parsed = JSON.parse(await handleAuditLog({ summary_only: true }, client));
    expect(parsed.summary.total_operations).toBe(0);
    expect(parsed.message).toBe('No write operations have been attempted yet');
  });

  it('rejects unexpected properties (strict schema)', async () => {
    await expect(handleAuditLog({ bogus: 1 }, client)).rejects.toThrow();
  });

  it('accepts every operation, resource type and outcome the log records (the enum mismatch, #60)', async () => {
    const targets = Object.values(WRITE_TOOL_AUDIT_TARGETS);
    for (const operation of new Set(targets.map((t) => t.operation))) {
      await expect(handleAuditLog({ operation }, client)).resolves.toBeDefined();
    }
    for (const resource_type of new Set(targets.map((t) => t.resourceType))) {
      await expect(handleAuditLog({ resource_type }, client)).resolves.toBeDefined();
    }
    for (const outcome of AUDIT_OUTCOMES) await expect(handleAuditLog({ outcome }, client)).resolves.toBeDefined();
    // The advertised JSON schema has the same lists.
    const props = auditLogTool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props['operation']?.enum).toEqual([...AUDIT_OPERATIONS]);
    expect(props['resource_type']?.enum).toEqual([...AUDIT_RESOURCE_TYPES]);
    expect(props['outcome']?.enum).toEqual([...AUDIT_OUTCOMES]);
    expect(AUDIT_OPERATIONS).toContain('move');
    await expect(handleAuditLog({ operation: 'write_limit_refused' }, client)).rejects.toThrow();
  });
});
