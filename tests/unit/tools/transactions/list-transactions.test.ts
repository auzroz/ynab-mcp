/**
 * List Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListTransactions } from '../../../../src/tools/transactions/list-transactions.js';
import {
  createMockClient,
  createTransactionsResponse,
  mockAllTransactions,
  mockGroceryTransactions,
  mockSplitTransaction,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists transactions sorted by date descending', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = await handleListTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(mockAllTransactions.length);
    // First should be most recent
    const dates = parsed.transactions.map((t: { date: string }) => t.date);
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : -1));
    expect(dates).toEqual(sorted);
    expect(parsed.summary.count).toBe(mockAllTransactions.length);
    expect(parsed.server_knowledge).toBe(12345);
  });

  it('calculates inflow, outflow, and net', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = await handleListTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_inflow).toBeDefined();
    expect(parsed.summary.total_outflow).toBeDefined();
    expect(parsed.summary.net).toBeDefined();
    expect(parsed.summary.date_range).toBeDefined();
  });

  it('applies limit', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = await handleListTransactions({ limit: 2 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(2);
    expect(parsed.filters_applied.limit).toBe(2);
  });

  it('passes since_date and type filters to the client', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockGroceryTransactions));

    const result = await handleListTransactions(
      { since_date: '2024-01-01', type: 'unapproved' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.getTransactions).toHaveBeenCalledWith('test-budget-id', {
      sinceDate: '2024-01-01',
      type: 'unapproved',
    });
    expect(parsed.filters_applied.since_date).toEqual({
      input: '2024-01-01',
      parsed: '2024-01-01',
    });
    expect(parsed.filters_applied.type).toBe('unapproved');
  });

  it('formats subtransactions when present', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([mockSplitTransaction]));

    const result = await handleListTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transactions[0].subtransactions).toBeInstanceOf(Array);
    expect(parsed.transactions[0].subtransactions.length).toBe(2);
  });

  it('handles empty results', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));

    const result = await handleListTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.transactions.length).toBe(0);
    expect(parsed.summary.count).toBe(0);
    expect(parsed.summary.date_range).toBeNull();
    expect(parsed.filters_applied.since_date).toBeNull();
    expect(parsed.filters_applied.type).toBeNull();
  });

  it('respects budget_id parameter', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));

    await handleListTransactions({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
