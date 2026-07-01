/**
 * List Account Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListAccountTransactions } from '../../../../src/tools/transactions/list-account-transactions.js';
import {
  createMockClient,
  createTransactionsResponse,
  mockAllTransactions,
  mockGroceryTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

describe('handleListAccountTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists account transactions sorted descending with summary', async () => {
    mockClient.getAccountTransactions.mockResolvedValue(
      createTransactionsResponse(mockAllTransactions)
    );

    const result = await handleListAccountTransactions(
      { account_id: ACCOUNT_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.account_id).toBe(ACCOUNT_ID);
    expect(parsed.transactions.length).toBe(mockAllTransactions.length);
    expect(parsed.summary.count).toBe(mockAllTransactions.length);
    expect(parsed.summary.total_inflow).toBeDefined();
    expect(parsed.summary.total_outflow).toBeDefined();
    expect(parsed.summary.net).toBeDefined();
    expect(mockClient.getAccountTransactions).toHaveBeenCalledWith(
      'test-budget-id',
      ACCOUNT_ID,
      undefined
    );
  });

  it('applies limit and passes parsed since_date', async () => {
    mockClient.getAccountTransactions.mockResolvedValue(
      createTransactionsResponse(mockGroceryTransactions)
    );

    const result = await handleListAccountTransactions(
      { account_id: ACCOUNT_ID, since_date: '2024-01-01', limit: 2 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(2);
    expect(mockClient.getAccountTransactions).toHaveBeenCalledWith(
      'test-budget-id',
      ACCOUNT_ID,
      '2024-01-01'
    );
  });

  it('handles empty results', async () => {
    mockClient.getAccountTransactions.mockResolvedValue(createTransactionsResponse([]));

    const result = await handleListAccountTransactions(
      { account_id: ACCOUNT_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(0);
    expect(parsed.summary.count).toBe(0);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getAccountTransactions.mockResolvedValue(createTransactionsResponse([]));

    await handleListAccountTransactions(
      { account_id: ACCOUNT_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
