/**
 * Audit Log Tool Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleAuditLog } from '../../../../src/tools/system/audit-log.js';
import { getAuditLog, _resetAuditLogForTesting } from '../../../../src/services/audit-log.js';

interface AuditEntry {
  operation: string;
  resourceType: string;
  success: boolean;
}

function seedEntries(): void {
  const log = getAuditLog();
  log.log({
    operation: 'create',
    tool: 'ynab_create_transaction',
    budgetId: 'budget-1',
    resourceType: 'transaction',
    details: {},
    success: true,
  });
  log.log({
    operation: 'update',
    tool: 'ynab_update_transaction',
    budgetId: 'budget-1',
    resourceType: 'transaction',
    details: {},
    success: true,
  });
  log.log({
    operation: 'delete',
    tool: 'ynab_delete_account',
    budgetId: 'budget-2',
    resourceType: 'account',
    details: {},
    success: false,
    error: 'Not found',
  });
}

describe('handleAuditLog', () => {
  beforeEach(() => {
    _resetAuditLogForTesting();
    // Silence the stderr [AUDIT] logging
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetAuditLogForTesting();
  });

  it('returns a message when no operations have been performed', async () => {
    const result = await handleAuditLog({});
    const parsed = JSON.parse(result);

    expect(parsed.entries).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.message).toBe('No matching audit log entries found');
    expect(parsed.summary.total_operations).toBe(0);
  });

  it('returns full entries most-recent-first with global summary', async () => {
    seedEntries();

    const result = await handleAuditLog({});
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(3);
    expect(parsed.entries[0].operation).toBe('delete'); // most recent first
    expect(parsed.summary.total_operations).toBe(3);
    expect(parsed.summary.success_count).toBe(2);
    expect(parsed.summary.failure_count).toBe(1);
    expect(parsed.message).toContain('Showing 3');
  });

  it('filters by operation', async () => {
    seedEntries();

    const result = await handleAuditLog({ operation: 'create' });
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.entries.every((e: AuditEntry) => e.operation === 'create')).toBe(true);
  });

  it('filters by resource_type and success', async () => {
    seedEntries();

    const result = await handleAuditLog({ resource_type: 'account', success: false });
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    expect(parsed.entries[0].resourceType).toBe('account');
    expect(parsed.entries[0].success).toBe(false);
  });

  it('respects the limit parameter', async () => {
    seedEntries();

    const result = await handleAuditLog({ limit: 1 });
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(1);
    // getFiltered returns most-recent-first, so the single entry is the delete.
    expect(parsed.entries[0].operation).toBe('delete');
  });

  it('returns a summary-only response without entries', async () => {
    seedEntries();

    const result = await handleAuditLog({ summary_only: true });
    const parsed = JSON.parse(result);

    expect(parsed.entries).toBeUndefined();
    expect(parsed.summary.total_operations).toBe(3);
    expect(parsed.summary.success_count).toBe(2);
    expect(parsed.summary.failure_count).toBe(1);
    expect(parsed.filters_applied).toBeUndefined();
    expect(parsed.message).toContain('3 operations logged');
  });

  it('returns a filtered summary-only response with filters_applied flag', async () => {
    seedEntries();

    const result = await handleAuditLog({ summary_only: true, operation: 'create' });
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_operations).toBe(1);
    expect(parsed.filters_applied).toBe(true);
    expect(parsed.message).toContain('(filtered)');
  });

  it('returns no-match message for filtered summary with zero results', async () => {
    seedEntries();

    const result = await handleAuditLog({ summary_only: true, resource_type: 'category' });
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_operations).toBe(0);
    expect(parsed.message).toBe('No matching audit log entries found');
  });

  it('returns no-write message for unfiltered summary with zero entries', async () => {
    const result = await handleAuditLog({ summary_only: true });
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_operations).toBe(0);
    expect(parsed.message).toBe('No write operations have been performed yet');
  });

  it('rejects unexpected properties (strict schema)', async () => {
    await expect(handleAuditLog({ bogus: 1 })).rejects.toThrow();
  });
});
