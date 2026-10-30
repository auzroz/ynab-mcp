/**
 * List Payee Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListPayeeTransactions } from '../../../../src/tools/transactions/list-payee-transactions.js';
import {
  createMockClient,
  createTransactionsResponse,
  mockAllTransactions,
  mockGroceryTransactions,
  mockIncomeTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const PAYEE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

describe('handleListPayeeTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists payee transactions with outflow/inflow split and top categories', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(
      createTransactionsResponse(mockGroceryTransactions)
    );

    const result = await handleListPayeeTransactions(
      { payee_id: PAYEE_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.payee_id).toBe(PAYEE_ID);
    expect(parsed.summary.outflow_count).toBe(mockGroceryTransactions.length);
    expect(parsed.summary.inflow_count).toBe(0);
    expect(parsed.summary.total_spent).toBeDefined();
    expect(parsed.summary.average_outflow).toBeDefined();
    expect(parsed.summary.top_categories[0].name).toBe('Groceries');
  });

  it('counts inflows separately', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(
      createTransactionsResponse(mockIncomeTransactions)
    );

    const result = await handleListPayeeTransactions(
      { payee_id: PAYEE_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.summary.inflow_count).toBe(mockIncomeTransactions.length);
    expect(parsed.summary.outflow_count).toBe(0);
    expect(parsed.summary.average_outflow).toBe('$0.00');
  });

  it('applies limit and passes parsed since_date', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(
      createTransactionsResponse(mockAllTransactions)
    );

    const result = await handleListPayeeTransactions(
      { payee_id: PAYEE_ID, since_date: '2024-01-01', limit: 3 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(3);
    expect(mockClient.getPayeeTransactions).toHaveBeenCalledWith(
      'test-budget-id',
      PAYEE_ID,
      '2024-01-01',
      undefined
    );
  });

  it('handles empty results', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(createTransactionsResponse([]));

    const result = await handleListPayeeTransactions(
      { payee_id: PAYEE_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.summary.count).toBe(0);
    expect(parsed.summary.top_categories).toEqual([]);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(createTransactionsResponse([]));

    await handleListPayeeTransactions(
      { payee_id: PAYEE_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });

  it('passes parsed until_date through and omits the default-range note', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(createTransactionsResponse([]));

    const parsed = JSON.parse(
      await handleListPayeeTransactions(
        { payee_id: PAYEE_ID, since_date: '2023-01-01', until_date: '2023-12-31' },
        mockClient as never
      )
    );

    expect(mockClient.getPayeeTransactions).toHaveBeenCalledWith(
      'test-budget-id',
      PAYEE_ID,
      '2023-01-01',
      '2023-12-31'
    );
    expect(parsed.summary.date_range_note).toBeUndefined();
  });

  it('notes the 12-month YNAB default when since_date is omitted', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(createTransactionsResponse([]));

    const parsed = JSON.parse(
      await handleListPayeeTransactions({ payee_id: PAYEE_ID }, mockClient as never)
    );

    expect(parsed.summary.date_range_note).toContain('last 12 months');
  });
});
