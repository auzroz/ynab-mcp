/**
 * Spending Analysis Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSpendingAnalysis } from '../../../../src/tools/analytics/spending-analysis.js';
import {
  createMockClient,
  createTransactionsResponse,
  createCategoriesResponse,
  mockAllTransactions,
  mockGroceryTransactions,
  mockDiningTransactions,
  mockCategoryGroups,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleSpendingAnalysis', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('analyzes spending by category', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.spending_by_category).toBeInstanceOf(Array);
    expect(parsed.spending_by_category.length).toBeGreaterThan(0);

    // Each category should have expected fields
    const firstCategory = parsed.spending_by_category[0];
    expect(firstCategory.category_name).toBeDefined();
    expect(firstCategory.total_spent).toBeDefined();
    expect(firstCategory.transaction_count).toBeGreaterThan(0);
    expect(firstCategory.percent_of_total).toBeDefined();
    expect(firstCategory.trend).toMatch(/increasing|decreasing|stable/);
  });

  it('calculates spending summary', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total_spent).toBeDefined();
    expect(parsed.summary.monthly_average).toBeDefined();
    expect(parsed.summary.daily_average).toBeDefined();
    expect(parsed.summary.transaction_count).toBeGreaterThan(0);
    expect(parsed.summary.category_count).toBeGreaterThan(0);
  });

  it('provides monthly spending breakdown', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.monthly_spending).toBeInstanceOf(Array);
    if (parsed.monthly_spending.length > 0) {
      const firstMonth = parsed.monthly_spending[0];
      expect(firstMonth.month).toMatch(/^\d{4}-\d{2}$/);
      expect(firstMonth.total_spent).toBeDefined();
      expect(firstMonth.category_breakdown).toBeInstanceOf(Array);
    }
  });

  it('identifies top spending categories', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.insights.top_5_categories).toBeInstanceOf(Array);
    expect(parsed.insights.top_5_categories.length).toBeLessThanOrEqual(5);

    // Top categories should be sorted by amount (descending)
    const amounts = parsed.insights.top_5_categories.map((c: { amount: string }) =>
      parseFloat(c.amount.replace(/[^0-9.-]/g, ''))
    );
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]).toBeLessThanOrEqual(amounts[i - 1]);
    }
  });

  it('respects months parameter', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({ months: 6 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.analysis_period).toBe('6 months');
  });

  it('filters by category_id when provided', async () => {
    const groceryOnly = mockGroceryTransactions;
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis(
      { category_id: 'cat-groceries-555' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    // Should only have one category in results
    expect(parsed.spending_by_category.length).toBe(1);
    expect(parsed.spending_by_category[0].category_id).toBe('cat-groceries-555');
  });

  it('excludes transfer transactions', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Transfers should not appear as spending categories
    const transferCategory = parsed.spending_by_category.find(
      (c: { category_name: string }) => c.category_name?.includes('Transfer')
    );
    expect(transferCategory).toBeUndefined();
  });

  it('excludes income transactions', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Income should not appear in spending analysis
    const incomeCategory = parsed.spending_by_category.find(
      (c: { category_name: string }) => c.category_name === 'Inflow: Ready to Assign'
    );
    expect(incomeCategory).toBeUndefined();
  });

  it('identifies increasing spending trends', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.insights.increasing_spending).toBeInstanceOf(Array);
    expect(parsed.insights.decreasing_spending).toBeInstanceOf(Array);
  });

  it('handles empty transaction list', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.spending_by_category).toEqual([]);
    expect(parsed.summary.total_spent).toBe('$0.00');
    expect(parsed.summary.transaction_count).toBe(0);
  });

  it('calculates correct percent of total', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleSpendingAnalysis({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Sum of all percentages should be approximately 100
    const totalPercent = parsed.spending_by_category.reduce(
      (sum: number, c: { percent_of_total: number }) => sum + c.percent_of_total,
      0
    );
    expect(totalPercent).toBeCloseTo(100, 0);
  });

  it('respects budget_id parameter', async () => {
    const customBudgetId = 'custom-budget-id';
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    await handleSpendingAnalysis({ budget_id: customBudgetId }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith(customBudgetId);
  });
});
