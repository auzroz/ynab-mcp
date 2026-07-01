/**
 * Delete Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleDeleteTransaction } from '../../../../src/tools/transactions/delete-transaction.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const TXN_ID = '99999999-9999-9999-9999-999999999999';

function deletedTxnResponse() {
  return {
    data: {
      transaction: {
        id: TXN_ID,
        date: '2024-02-01',
        amount: -42500,
        payee_name: 'Amazon',
        category_name: 'Shopping',
        account_name: 'Primary Checking',
      },
    },
  };
}

describe('handleDeleteTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('deletes a transaction and returns success', async () => {
    mockClient.deleteTransaction.mockResolvedValue(deletedTxnResponse());

    const result = await handleDeleteTransaction({ transaction_id: TXN_ID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(mockClient.deleteTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID);
    expect(parsed.success).toBe(true);
    expect(parsed.deleted_transaction.id).toBe(TXN_ID);
    expect(parsed.deleted_transaction.amount).toBe('-$42.50');
    expect(parsed.message).toContain('2024-02-01');
  });

  it('throws when no transaction is returned', async () => {
    mockClient.deleteTransaction.mockResolvedValue({ data: { transaction: null } });

    await expect(
      handleDeleteTransaction({ transaction_id: TXN_ID }, mockClient as never)
    ).rejects.toThrow('no transaction returned');
  });

  it('respects budget_id parameter', async () => {
    mockClient.deleteTransaction.mockResolvedValue(deletedTxnResponse());

    await handleDeleteTransaction(
      { transaction_id: TXN_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
