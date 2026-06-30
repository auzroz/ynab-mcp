/**
 * Savings Opportunities Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSavingsOpportunities } from '../../../../src/tools/analytics/savings-opportunities.js';
import {
  createMockClient,
  createTransactionsResponse,
  createCategoriesResponse,
  mockCategoryGroups,
  mockAllTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleSavingsOpportunities', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns opportunities and summary for realistic data', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSavingsOpportunities({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.opportunities).toBeInstanceOf(Array);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total_opportunities_found).toBeGreaterThanOrEqual(0);
    expect(parsed.summary.analysis_period).toBe('3 months');
    expect(parsed.quick_wins).toBeInstanceOf(Array);
  });

  it('flags discretionary spending opportunities', async () => {
    // Dining Out category (cat-dining-666) is in "Everyday Expenses" group but
    // category name "Dining Out" contains "dining" -> discretionary.
    // Build several months of dining spend > $50/month average.
    const diningTxns = [];
    for (let m = 1; m <= 3; m++) {
      const month = String(m).padStart(2, '0');
      diningTxns.push({
        id: `dine-${m}`,
        date: `2024-${month}-10`,
        amount: -30000, // $300/month
        payee_id: `payee-rest-${m}`,
        payee_name: `Restaurant ${m}`,
        category_id: 'cat-dining-666',
        category_name: 'Dining Out',
        transfer_account_id: null,
        deleted: false,
        account_id: 'acct-1',
      });
    }
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(diningTxns as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSavingsOpportunities({}, mockClient as never);
    const parsed = JSON.parse(result);

    const discretionary = parsed.opportunities.find(
      (o: { type: string }) => o.type === 'discretionary'
    );
    expect(discretionary).toBeDefined();
    expect(discretionary.category).toBe('Dining Out');
  });

  it('detects recurring subscription-like charges as high-confidence quick wins', async () => {
    // Same payee, consistent amount in $5-$500 range, >= 2 occurrences.
    const subs = [
      { id: 's1', date: '2024-01-01', amount: -15990, payee_id: 'p-netflix', payee_name: 'Netflix', category_id: 'cat-subscriptions-ddd', category_name: 'Subscriptions', transfer_account_id: null, deleted: false, account_id: 'acct-1' },
      { id: 's2', date: '2024-02-01', amount: -15990, payee_id: 'p-netflix', payee_name: 'Netflix', category_id: 'cat-subscriptions-ddd', category_name: 'Subscriptions', transfer_account_id: null, deleted: false, account_id: 'acct-1' },
      { id: 's3', date: '2024-03-01', amount: -15990, payee_id: 'p-netflix', payee_name: 'Netflix', category_id: 'cat-subscriptions-ddd', category_name: 'Subscriptions', transfer_account_id: null, deleted: false, account_id: 'acct-1' },
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(subs as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSavingsOpportunities({}, mockClient as never);
    const parsed = JSON.parse(result);

    const recurring = parsed.opportunities.find(
      (o: { type: string }) => o.type === 'recurring_expense'
    );
    expect(recurring).toBeDefined();
    expect(recurring.confidence).toBe('high');
    expect(parsed.quick_wins.length).toBeGreaterThan(0);
    expect(parsed.summary.high_confidence_savings_milliunits).toBeGreaterThan(0);
  });

  it('handles empty transactions gracefully', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSavingsOpportunities({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.opportunities).toEqual([]);
    expect(parsed.summary.total_opportunities_found).toBe(0);
    expect(parsed.summary.potential_savings_percent).toBe(0);
    expect(parsed.quick_wins).toEqual([]);
  });

  it('respects months parameter', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSavingsOpportunities({ months: 6 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.analysis_period).toBe('6 months');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    await handleSavingsOpportunities({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
