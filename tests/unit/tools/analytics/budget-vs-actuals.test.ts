/**
 * Budget vs Actuals Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBudgetVsActuals } from '../../../../src/tools/analytics/budget-vs-actuals.js';
import {
  createMockClient,
  createMonthResponse,
  createCategoriesResponse,
  mockCategoryGroups,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleBudgetVsActuals', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns a budget vs actuals report for a month', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetVsActuals({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.month).toBe('2024-01-01');
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total_budgeted).toBeDefined();
    expect(parsed.summary.total_activity).toBeDefined();
    expect(parsed.by_group).toBeInstanceOf(Array);
    expect(parsed.alerts).toBeDefined();
    expect(parsed.previous_month_comparison).toBeNull();
  });

  it('identifies overspent categories in alerts', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetVsActuals({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    // Dining Out (-$75) and Subscriptions (-$15) have negative balances
    expect(parsed.summary.overspent_categories).toBeGreaterThan(0);
    expect(parsed.alerts.overspent.length).toBeGreaterThan(0);
    const dining = parsed.alerts.overspent.find(
      (c: { category: string }) => c.category === 'Dining Out'
    );
    expect(dining).toBeDefined();
  });

  it('groups categories and excludes internal/hidden', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetVsActuals({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    const groupNames = parsed.by_group.map((g: { group_name: string }) => g.group_name);
    expect(groupNames).not.toContain('Internal Master Category');
    expect(groupNames).toContain('Bills');
  });

  it('includes previous month comparison when requested', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetVsActuals(
      { month: '2024-02-01', include_previous: true },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.previous_month_comparison).not.toBeNull();
    expect(parsed.previous_month_comparison.month).toBe('2024-01-01');
    expect(parsed.previous_month_comparison.activity_change).toBeDefined();
    // getBudgetMonth called for current + previous month
    expect(mockClient.getBudgetMonth).toHaveBeenCalledTimes(2);
  });

  it('handles January previous-month rollover to December of prior year', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetVsActuals(
      { month: '2024-01-01', include_previous: true },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.previous_month_comparison.month).toBe('2023-12-01');
  });

  it('handles empty month categories', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      createMonthResponse({ ...mockMonthDetail, categories: [] })
    );
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetVsActuals({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.by_group).toEqual([]);
    expect(parsed.summary.overspent_categories).toBe(0);
    expect(parsed.summary.budget_usage_percent).toBe(0);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    await handleBudgetVsActuals(
      { month: '2024-01-01', budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
