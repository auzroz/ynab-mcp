/**
 * List Category Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListCategoryTransactions } from '../../../../src/tools/transactions/list-category-transactions.js';
import {
  createMockClient,
  createTransactionsResponse,
  mockGroceryTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const CATEGORY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('handleListCategoryTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists category transactions with spending summary and top payees', async () => {
    mockClient.getCategoryTransactions.mockResolvedValue(
      createTransactionsResponse(mockGroceryTransactions)
    );

    const result = await handleListCategoryTransactions(
      { category_id: CATEGORY_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.category_id).toBe(CATEGORY_ID);
    expect(parsed.transactions.length).toBe(mockGroceryTransactions.length);
    expect(parsed.summary.total_spent).toBeDefined();
    expect(parsed.summary.top_payees).toBeInstanceOf(Array);
    // Kroger appears 3 times, should be top payee
    expect(parsed.summary.top_payees[0].name).toBe('Kroger');
    expect(mockClient.getCategoryTransactions).toHaveBeenCalledWith(
      'test-budget-id',
      CATEGORY_ID,
      undefined
    );
  });

  it('does not mutate the response and applies limit', async () => {
    mockClient.getCategoryTransactions.mockResolvedValue(
      createTransactionsResponse(mockGroceryTransactions)
    );

    const result = await handleListCategoryTransactions(
      { category_id: CATEGORY_ID, limit: 2 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(2);
  });

  it('passes parsed since_date', async () => {
    mockClient.getCategoryTransactions.mockResolvedValue(createTransactionsResponse([]));

    await handleListCategoryTransactions(
      { category_id: CATEGORY_ID, since_date: '2024-01-01' },
      mockClient as never
    );

    expect(mockClient.getCategoryTransactions).toHaveBeenCalledWith(
      'test-budget-id',
      CATEGORY_ID,
      '2024-01-01'
    );
  });

  it('handles empty results', async () => {
    mockClient.getCategoryTransactions.mockResolvedValue(createTransactionsResponse([]));

    const result = await handleListCategoryTransactions(
      { category_id: CATEGORY_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(0);
    expect(parsed.summary.top_payees).toEqual([]);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getCategoryTransactions.mockResolvedValue(createTransactionsResponse([]));

    await handleListCategoryTransactions(
      { category_id: CATEGORY_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
