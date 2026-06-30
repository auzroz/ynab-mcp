/**
 * Import Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleImportTransactions } from '../../../../src/tools/transactions/import-transactions.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleImportTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('imports transactions and reports the count', async () => {
    mockClient.importTransactions.mockResolvedValue({
      data: { transaction_ids: ['imp-1', 'imp-2', 'imp-3'] },
    });

    const result = await handleImportTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(mockClient.importTransactions).toHaveBeenCalledWith('test-budget-id');
    expect(parsed.success).toBe(true);
    expect(parsed.imported_count).toBe(3);
    expect(parsed.message).toContain('3');
    // include_ids defaults to false
    expect(parsed.transaction_ids).toBeUndefined();
  });

  it('includes ids when include_ids is true', async () => {
    mockClient.importTransactions.mockResolvedValue({
      data: { transaction_ids: ['imp-1', 'imp-2'] },
    });

    const result = await handleImportTransactions({ include_ids: true }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transaction_ids).toEqual(['imp-1', 'imp-2']);
  });

  it('reports no new transactions when none imported', async () => {
    mockClient.importTransactions.mockResolvedValue({ data: { transaction_ids: [] } });

    const result = await handleImportTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.imported_count).toBe(0);
    expect(parsed.message).toBe('No new transactions to import');
  });

  it('respects budget_id parameter', async () => {
    mockClient.importTransactions.mockResolvedValue({ data: { transaction_ids: [] } });

    await handleImportTransactions({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
