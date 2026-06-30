/**
 * Transaction Search Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleTransactionSearch } from '../../../../src/tools/analytics/transaction-search.js';
import {
  createMockClient,
  createAccountsResponse,
  createCategoriesResponse,
  createTransactionsResponse,
  mockAllAccounts,
  mockAllTransactions,
  mockGroceryTransactions,
  mockDiningTransactions,
  mockIncomeTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleTransactionSearch', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  it('returns all non-deleted transactions with summary stats', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(await handleTransactionSearch({}, mockClient as never));

    expect(result.summary.total_matches).toBe(mockAllTransactions.length);
    expect(result.search.criteria).toBe('all transactions');
    expect(result.summary.total_inflow).toBeDefined();
    expect(result.summary.total_outflow).toBeDefined();
  });

  it('filters by payee (partial match, case-insensitive)', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ payee: 'kroger' }, mockClient as never)
    );

    expect(result.summary.total_matches).toBe(3); // 3 Kroger grocery txns
    expect(result.transactions.every((t: { payee: string }) => /Kroger/i.test(t.payee))).toBe(true);
  });

  it('filters by category (partial match)', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ category: 'dining' }, mockClient as never)
    );

    expect(result.summary.total_matches).toBe(mockDiningTransactions.length);
  });

  it('filters by amount range (absolute values)', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ min_amount: 80, max_amount: 100 }, mockClient as never)
    );

    expect(result.summary.total_matches).toBeGreaterThan(0);
    // Every returned transaction's absolute amount must fall within [80, 100],
    // and the out-of-range $105 transaction must be excluded.
    const matchesDollar = result.transactions.map((t: { amount: string }) => t.amount);
    expect(matchesDollar).not.toContain('-$105.00');
    for (const amount of matchesDollar) {
      const value = Math.abs(parseFloat(amount.replace(/[^0-9.-]/g, '')));
      expect(value).toBeGreaterThanOrEqual(80);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('filters by transaction type (inflow only)', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ type: 'inflow' }, mockClient as never)
    );

    expect(result.summary.total_matches).toBe(mockIncomeTransactions.length);
    expect(result.search.criteria).toContain('type: inflow');
  });

  it('filters by until_date', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockGroceryTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ until_date: '2024-01-12' }, mockClient as never)
    );

    // grocery txns on/before 2024-01-12 => 2 of them
    expect(result.summary.total_matches).toBe(2);
    expect(result.search.date_range.to).toBe('2024-01-12');
  });

  it('matches free-text query against payee, memo, or category', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ query: 'weekly groceries' }, mockClient as never)
    );

    // matches the memo "Weekly groceries"
    expect(result.summary.total_matches).toBe(1);
    expect(result.transactions[0].memo).toBe('Weekly groceries');
  });

  it('applies the limit and reports has_more', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = JSON.parse(
      await handleTransactionSearch({ limit: 3 }, mockClient as never)
    );

    expect(result.summary.showing).toBe(3);
    expect(result.has_more).toBe(true);
  });

  it('passes since_date to the API call as a filter option', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockGroceryTransactions));

    await handleTransactionSearch({ since_date: '2024-01-01' }, mockClient as never);

    expect(mockClient.getTransactions).toHaveBeenCalledWith('test-budget-id', {
      sinceDate: '2024-01-01',
    });
  });

  it('returns empty results gracefully', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));

    const result = JSON.parse(await handleTransactionSearch({}, mockClient as never));

    expect(result.summary.total_matches).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.has_more).toBe(false);
  });
});
