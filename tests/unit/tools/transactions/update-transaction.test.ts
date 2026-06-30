/**
 * Update Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUpdateTransaction } from '../../../../src/tools/transactions/update-transaction.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const TXN_ID = '99999999-9999-9999-9999-999999999999';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';

function updatedTxnResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      transaction: {
        id: TXN_ID,
        date: '2024-02-01',
        amount: -42500,
        payee_name: 'Amazon',
        category_name: 'Shopping',
        account_name: 'Primary Checking',
        memo: 'Updated',
        cleared: 'cleared',
        approved: true,
        flag_color: 'blue',
        ...overrides,
      },
    },
  };
}

describe('handleUpdateTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('updates a single field', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    const result = await handleUpdateTransaction(
      { transaction_id: TXN_ID, category_id: CATEGORY_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.updateTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID, {
      transaction: { category_id: CATEGORY_ID },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.transaction.id).toBe(TXN_ID);
  });

  it('converts amount dollars to milliunits', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    await handleUpdateTransaction(
      { transaction_id: TXN_ID, amount: -42.5 },
      mockClient as never
    );

    expect(mockClient.updateTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID, {
      transaction: { amount: -42500 },
    });
  });

  it('passes all provided fields including null flag_color', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    await handleUpdateTransaction(
      {
        transaction_id: TXN_ID,
        date: '2024-03-01',
        memo: 'note',
        cleared: 'reconciled',
        approved: false,
        flag_color: null,
      },
      mockClient as never
    );

    expect(mockClient.updateTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID, {
      transaction: {
        date: '2024-03-01',
        memo: 'note',
        cleared: 'reconciled',
        approved: false,
        flag_color: null,
      },
    });
  });

  it('rejects when no fields are provided to update', async () => {
    await expect(
      handleUpdateTransaction({ transaction_id: TXN_ID }, mockClient as never)
    ).rejects.toThrow(/at least one field/i);
  });

  it('rejects when both payee_id and payee_name provided', async () => {
    await expect(
      handleUpdateTransaction(
        {
          transaction_id: TXN_ID,
          payee_id: '22222222-2222-2222-2222-222222222222',
          payee_name: 'Store',
        },
        mockClient as never
      )
    ).rejects.toThrow(/not both/i);
  });

  it('respects budget_id parameter', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    await handleUpdateTransaction(
      { transaction_id: TXN_ID, memo: 'x', budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
