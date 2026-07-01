/**
 * Get Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetTransaction } from '../../../../src/tools/transactions/get-transaction.js';
import {
  createMockClient,
  createTransactionResponse,
  mockGroceryTransactions,
  mockSplitTransaction,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const TXN_ID = '99999999-9999-9999-9999-999999999999';

describe('handleGetTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns transaction details', async () => {
    mockClient.getTransactionById.mockResolvedValue(
      createTransactionResponse(mockGroceryTransactions[0])
    );

    const result = await handleGetTransaction({ transaction_id: TXN_ID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transaction.id).toBe(mockGroceryTransactions[0]!.id);
    expect(parsed.transaction.amount).toBe('-$85.00');
    expect(parsed.transaction.payee_name).toBe('Kroger');
    expect(parsed.transaction.subtransactions).toEqual([]);
    expect(mockClient.getTransactionById).toHaveBeenCalledWith('test-budget-id', TXN_ID);
  });

  it('includes formatted subtransactions when present', async () => {
    mockClient.getTransactionById.mockResolvedValue(
      createTransactionResponse(mockSplitTransaction)
    );

    const result = await handleGetTransaction({ transaction_id: TXN_ID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transaction.subtransactions.length).toBe(2);
    expect(parsed.transaction.subtransactions[0].amount).toBe('-$100.00');
    expect(parsed.transaction.subtransactions[0].category_name).toBe('Entertainment');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getTransactionById.mockResolvedValue(
      createTransactionResponse(mockGroceryTransactions[0])
    );

    await handleGetTransaction(
      { transaction_id: TXN_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
