/**
 * Spending Trends Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSpendingTrends } from '../../../../src/tools/analytics/spending-trends.js';
import {
  createMockClient,
  createMonthResponse,
  createCategoriesResponse,
  mockCategoryGroups,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleSpendingTrends', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns trend analysis across months', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));

    const result = await handleSpendingTrends({ months: 6 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.period.months_analyzed).toBe(6);
    expect(parsed.overall).toBeDefined();
    expect(parsed.overall.trend).toMatch(/increasing|decreasing|stable/);
    expect(parsed.monthly_totals.length).toBe(6);
    expect(parsed.summary.categories_analyzed).toBeGreaterThan(0);
    expect(parsed.all_trends).toBeInstanceOf(Array);
    // Identical month data => stable overall trend.
    expect(parsed.overall.trend).toBe('stable');
    expect(parsed.overall.change_percent).toBe(0);
  });

  it('detects an increasing overall trend when later months spend more', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    // Return progressively larger spending each call (oldest month first).
    let callIndex = 0;
    const groceriesId = 'cat-groceries-555';
    mockClient.getBudgetMonth.mockImplementation(async () => {
      const i = callIndex++;
      const activity = -((i + 1) * 100000); // grows each month
      return createMonthResponse({
        ...mockMonthDetail,
        categories: [
          {
            ...mockMonthDetail.categories.find((c) => c.id === groceriesId)!,
            activity,
          },
        ],
      });
    });

    const result = await handleSpendingTrends({ months: 4 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.overall.trend).toBe('increasing');
    expect(parsed.summary.increasing).toBeGreaterThan(0);
    expect(parsed.notable_increases.length).toBeGreaterThan(0);
  });

  it('detects a decreasing overall trend when later months spend less', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    let callIndex = 0;
    const groceriesId = 'cat-groceries-555';
    mockClient.getBudgetMonth.mockImplementation(async () => {
      const i = callIndex++;
      const activity = -((4 - i) * 100000); // shrinks each month
      return createMonthResponse({
        ...mockMonthDetail,
        categories: [
          {
            ...mockMonthDetail.categories.find((c) => c.id === groceriesId)!,
            activity,
          },
        ],
      });
    });

    const result = await handleSpendingTrends({ months: 4 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.overall.trend).toBe('decreasing');
    expect(parsed.summary.decreasing).toBeGreaterThan(0);
    expect(parsed.notable_decreases.length).toBeGreaterThan(0);
  });

  it('filters to a single category when category_id is provided', async () => {
    // Schema requires a valid UUID for category_id.
    const targetId = '99999999-9999-4999-8999-999999999999';
    const groupsWithUuidCat = [
      {
        id: 'group-test',
        name: 'Test Group',
        hidden: false,
        deleted: false,
        categories: [
          { id: targetId, name: 'Target Cat', hidden: false },
          { id: 'other-cat', name: 'Other Cat', hidden: false },
        ],
      },
    ];
    const monthWithUuidCat = {
      ...mockMonthDetail,
      categories: [
        { ...mockMonthDetail.categories[0]!, id: targetId, name: 'Target Cat', hidden: false, activity: -50000 },
        { ...mockMonthDetail.categories[0]!, id: 'other-cat', name: 'Other Cat', hidden: false, activity: -90000 },
      ],
    };
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(groupsWithUuidCat as never));
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(monthWithUuidCat));

    const result = await handleSpendingTrends(
      { months: 4, category_id: targetId },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    // Only the requested category should appear in trends.
    expect(parsed.summary.categories_analyzed).toBe(1);
    expect(parsed.all_trends[0].category_name).toBe('Target Cat');
  });

  it('handles months with no spending (empty trends)', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));
    // All categories have zero/positive activity => no spending trends.
    const noSpend = mockMonthDetail.categories.map((c) => ({ ...c, activity: 0 }));
    mockClient.getBudgetMonth.mockResolvedValue(
      createMonthResponse({ ...mockMonthDetail, categories: noSpend })
    );

    const result = await handleSpendingTrends({ months: 3 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.categories_analyzed).toBe(0);
    expect(parsed.all_trends).toEqual([]);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));

    await handleSpendingTrends({ months: 2, budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
