/**
 * Audit Log Service Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AuditLog } from '../../../src/services/audit-log.js';

describe('AuditLog', () => {
  let auditLog: AuditLog;

  beforeEach(() => {
    auditLog = new AuditLog(100);
  });

  describe('log', () => {
    it('should add entries with timestamp', () => {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_transaction',
        budgetId: 'budget-123',
        resourceType: 'transaction',
        resourceId: 'txn-456',
        details: { amount: 10000 },
        success: true,
      });

      const entries = auditLog.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        operation: 'create',
        tool: 'ynab_create_transaction',
        budgetId: 'budget-123',
        resourceType: 'transaction',
        resourceId: 'txn-456',
        success: true,
      });
      expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should log errors for failed operations', () => {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_transaction',
        budgetId: 'budget-123',
        resourceType: 'transaction',
        details: {},
        success: false,
        error: 'API rate limit exceeded',
      });

      const entries = auditLog.getAll();
      expect(entries[0]?.success).toBe(false);
      expect(entries[0]?.error).toBe('API rate limit exceeded');
    });

    it('should trim old entries when exceeding max', () => {
      const smallLog = new AuditLog(3);

      for (let i = 0; i < 5; i++) {
        smallLog.log({
          operation: 'create',
          tool: 'test_tool',
          budgetId: 'budget-123',
          resourceType: 'transaction',
          details: { index: i },
          success: true,
        });
      }

      const entries = smallLog.getAll();
      expect(entries).toHaveLength(3);
      // Should have the last 3 entries (index 2, 3, 4)
      expect((entries[0]?.details as { index: number }).index).toBe(2);
      expect((entries[2]?.details as { index: number }).index).toBe(4);
    });
  });

  describe('getFiltered', () => {
    beforeEach(() => {
      // Add various entries for filtering tests
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_transaction',
        budgetId: 'budget-1',
        resourceType: 'transaction',
        details: {},
        success: true,
      });
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_transaction',
        budgetId: 'budget-1',
        resourceType: 'transaction',
        details: {},
        success: true,
      });
      auditLog.log({
        operation: 'delete',
        tool: 'ynab_delete_transaction',
        budgetId: 'budget-2',
        resourceType: 'transaction',
        details: {},
        success: false,
        error: 'Not found',
      });
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_account',
        budgetId: 'budget-1',
        resourceType: 'account',
        details: {},
        success: true,
      });
    });

    it('should filter by operation', () => {
      const entries = auditLog.getFiltered({ operation: 'create' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.operation === 'create')).toBe(true);
    });

    it('should filter by resourceType', () => {
      const entries = auditLog.getFiltered({ resourceType: 'account' });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.resourceType).toBe('account');
    });

    it('should filter by success', () => {
      const failed = auditLog.getFiltered({ success: false });
      expect(failed).toHaveLength(1);
      expect(failed[0]?.success).toBe(false);

      const succeeded = auditLog.getFiltered({ success: true });
      expect(succeeded).toHaveLength(3);
    });

    it('should filter by budgetId', () => {
      const entries = auditLog.getFiltered({ budgetId: 'budget-2' });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.budgetId).toBe('budget-2');
    });

    it('should limit results', () => {
      const entries = auditLog.getFiltered({ limit: 2 });
      expect(entries).toHaveLength(2);
    });

    it('should return most recent first', () => {
      const entries = auditLog.getFiltered({});
      // Last logged is account creation
      expect(entries[0]?.resourceType).toBe('account');
    });

    it('should combine multiple filters', () => {
      const entries = auditLog.getFiltered({
        operation: 'create',
        resourceType: 'transaction',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.tool).toBe('ynab_create_transaction');
    });
  });

  describe('getSummary', () => {
    it('should return empty summary for no entries', () => {
      const summary = auditLog.getSummary();
      expect(summary.totalOperations).toBe(0);
      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(0);
      expect(summary.oldestEntry).toBeUndefined();
      expect(summary.newestEntry).toBeUndefined();
    });

    it('should return correct counts', () => {
      auditLog.log({
        operation: 'create',
        tool: 'test',
        budgetId: 'b1',
        resourceType: 'transaction',
        details: {},
        success: true,
      });
      auditLog.log({
        operation: 'create',
        tool: 'test',
        budgetId: 'b1',
        resourceType: 'transaction',
        details: {},
        success: false,
        error: 'test error',
      });
      auditLog.log({
        operation: 'update',
        tool: 'test',
        budgetId: 'b1',
        resourceType: 'account',
        details: {},
        success: true,
      });

      const summary = auditLog.getSummary();
      expect(summary.totalOperations).toBe(3);
      expect(summary.successCount).toBe(2);
      expect(summary.failureCount).toBe(1);
      expect(summary.byOperation).toEqual({ create: 2, update: 1 });
      expect(summary.byResourceType).toEqual({ transaction: 2, account: 1 });
      expect(summary.oldestEntry).toBeDefined();
      expect(summary.newestEntry).toBeDefined();
    });
  });

  describe('clear', () => {
    it('should clear all entries and return count', () => {
      auditLog.log({
        operation: 'create',
        tool: 'test',
        budgetId: 'b1',
        resourceType: 'transaction',
        details: {},
        success: true,
      });
      auditLog.log({
        operation: 'update',
        tool: 'test',
        budgetId: 'b1',
        resourceType: 'transaction',
        details: {},
        success: true,
      });

      const count = auditLog.clear();
      expect(count).toBe(2);
      expect(auditLog.getAll()).toHaveLength(0);
    });
  });
});
