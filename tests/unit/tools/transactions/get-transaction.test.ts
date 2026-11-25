/**
 * Get Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetTransaction as rawHandleGetTransaction, getTransactionOutputSchema } from '../../../../src/tools/transactions/get-transaction.js';
import { validating } from '../output-validation.js';
import {
  createMockClient,
  createTransactionResponse,
  mockGroceryTransactions,
  mockSplitTransaction,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleGetTransaction = validating(getTransactionOutputSchema, rawHandleGetTransaction);

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

    const parsed = await handleGetTransaction({ transaction_id: TXN_ID }, mockClient as never);

    expect(parsed.transaction.id).toBe(mockGroceryTransactions[0]!.id);
    expect(parsed.transaction.amount).toBe('-$85.00');
    expect(parsed.transaction.payee_name).toBe('Kroger');
    expect(parsed.transaction.subtransactions).toEqual([]);
    expect(mockClient.getTransactionById).toHaveBeenCalledWith('test-budget-id', TXN_ID);
  });

  it('sanitizes the client-written import_id', async () => {
    mockClient.getTransactionById.mockResolvedValue(
      createTransactionResponse({ ...mockGroceryTransactions[0]!, import_id: 'YNAB:\u0000-8500:\u200b2024' })
    );

    const parsed = await handleGetTransaction({ transaction_id: TXN_ID }, mockClient as never);

    expect(parsed.transaction.import_id).not.toMatch(/[\u0000\u200b]/);
    expect(parsed.transaction.import_id).toContain('YNAB:');
  });

  it('includes formatted subtransactions when present', async () => {
    mockClient.getTransactionById.mockResolvedValue(
      createTransactionResponse(mockSplitTransaction)
    );

    const parsed = await handleGetTransaction({ transaction_id: TXN_ID }, mockClient as never);

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
