/**
 * Import Transactions Tool Tests (deprecated tool)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleImportTransactions,
  importTransactionsTool,
  IMPORT_DEPRECATION_MESSAGE,
} from '../../../../src/tools/transactions/import-transactions.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('importTransactionsTool definition', () => {
  it('description starts with DEPRECATED:', () => {
    expect(importTransactionsTool.description?.startsWith('DEPRECATED:')).toBe(true);
  });

  it('does not contain sync-style trigger phrases', () => {
    const description = importTransactionsTool.description ?? '';
    expect(description).not.toContain('Import my bank transactions');
    expect(description).not.toContain('Sync my accounts');
    expect(description).not.toContain('Refresh bank connections');
    expect(description).toContain('Do NOT use this tool to sync');
  });
});

describe('handleImportTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('marks the response as deprecated with a clear message', async () => {
    mockClient.importTransactions.mockResolvedValue({ data: { transaction_ids: [] } });

    const result = await handleImportTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(mockClient.importTransactions).toHaveBeenCalledWith('test-budget-id');
    expect(parsed.success).toBe(true);
    expect(parsed.deprecated).toBe(true);
    expect(parsed.message).toBe(IMPORT_DEPRECATION_MESSAGE);
    expect(parsed.message).toContain('deprecated');
    expect(parsed.imported_count).toBe(0);
    expect(parsed.transaction_ids).toBeUndefined();
  });

  it('reports the returned count and still flags deprecated', async () => {
    mockClient.importTransactions.mockResolvedValue({
      data: { transaction_ids: ['imp-1', 'imp-2'] },
    });

    const result = await handleImportTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.deprecated).toBe(true);
    expect(parsed.imported_count).toBe(2);
  });

  it('includes ids when include_ids is true', async () => {
    mockClient.importTransactions.mockResolvedValue({
      data: { transaction_ids: ['imp-1', 'imp-2'] },
    });

    const result = await handleImportTransactions({ include_ids: true }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transaction_ids).toEqual(['imp-1', 'imp-2']);
    expect(parsed.deprecated).toBe(true);
  });

  it('respects budget_id parameter', async () => {
    mockClient.importTransactions.mockResolvedValue({ data: { transaction_ids: [] } });

    await handleImportTransactions({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
