/**
 * Budget Suggestions Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBudgetSuggestions } from '../../../../src/tools/analytics/budget-suggestions.js';
import {
  createMockClient,
  createCategoriesResponse,
  createMonthResponse,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

// Build a month detail whose categories carry the given activity/budgeted values.
// Category ids are reused from mockCategoryGroups so groupLookup resolves them.
function monthWith(
  categories: Array<{ id: string; name: string; activity: number; budgeted: number; hidden?: boolean }>
) {
  return createMonthResponse({
    ...mockMonthDetail,
    categories: categories.map((c) => ({
      ...mockMonthDetail.categories[0]!,
      id: c.id,
      name: c.name,
      activity: c.activity,
      budgeted: c.budgeted,
      balance: 0,
      hidden: c.hidden ?? false,
    })),
  });
}

describe('handleBudgetSuggestions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-04-15T12:00:00Z'));
    mockClient = createMockClient();
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns insufficient-history message when no historical months resolve', async () => {
    // current month succeeds, historical months reject
    mockClient.getBudgetMonth.mockImplementation((_budget: string, month: string) => {
      if (month === '2024-04-01') {
        return Promise.resolve(monthWith([]));
      }
      return Promise.reject(new Error('not found'));
    });

    const result = JSON.parse(
      await handleBudgetSuggestions({ months: 3 }, mockClient as never)
    );

    expect(result.message).toContain('Insufficient budget history');
    expect(result.analysis_period.months_available).toBe(0);
  });

  it('recommends an increase when spending exceeds current budget', async () => {
    // Current month: groceries budgeted $100. Historical avg spending ~$200 => suggest increase.
    mockClient.getBudgetMonth.mockImplementation((_budget: string, month: string) => {
      if (month === '2024-04-01') {
        return Promise.resolve(
          monthWith([{ id: 'cat-groceries-555', name: 'Groceries', activity: 0, budgeted: 100000 }])
        );
      }
      return Promise.resolve(
        monthWith([{ id: 'cat-groceries-555', name: 'Groceries', activity: -200000, budgeted: 0 }])
      );
    });

    const result = JSON.parse(
      await handleBudgetSuggestions({ months: 3 }, mockClient as never)
    );

    expect(result.analysis_period.months_available).toBe(3);
    expect(result.summary.needs_increase).toBeGreaterThan(0);
    const grocery = result.needs_increase.find((s: { category: string }) => s.category === 'Groceries');
    expect(grocery).toBeDefined();
    expect(grocery.confidence).toBe('high'); // 3 months, consistent
  });

  it('recommends a decrease when current budget far exceeds spending', async () => {
    mockClient.getBudgetMonth.mockImplementation((_budget: string, month: string) => {
      if (month === '2024-04-01') {
        return Promise.resolve(
          monthWith([{ id: 'cat-dining-666', name: 'Dining Out', activity: 0, budgeted: 500000 }])
        );
      }
      return Promise.resolve(
        monthWith([{ id: 'cat-dining-666', name: 'Dining Out', activity: -50000, budgeted: 0 }])
      );
    });

    const result = JSON.parse(
      await handleBudgetSuggestions({ months: 2 }, mockClient as never)
    );

    expect(result.summary.can_decrease).toBeGreaterThan(0);
    const dining = result.can_decrease.find((s: { category: string }) => s.category === 'Dining Out');
    expect(dining).toBeDefined();
  });

  it('classifies a category as on_target when budget matches spending', async () => {
    // avg spending $90 => suggested = ceil(99000/5000)*5000 = 100000 == current budget
    mockClient.getBudgetMonth.mockImplementation((_budget: string, month: string) => {
      if (month === '2024-04-01') {
        return Promise.resolve(
          monthWith([{ id: 'cat-gas-888', name: 'Gas', activity: 0, budgeted: 100000 }])
        );
      }
      return Promise.resolve(
        monthWith([{ id: 'cat-gas-888', name: 'Gas', activity: -90000, budgeted: 0 }])
      );
    });

    const result = JSON.parse(
      await handleBudgetSuggestions({ months: 1 }, mockClient as never)
    );

    expect(result.summary.on_target).toBeGreaterThan(0);
    const gas = result.on_target.find((s: { category: string }) => s.category === 'Gas');
    expect(gas).toBeDefined();
  });

  it('skips hidden and internal-master categories', async () => {
    mockClient.getBudgetMonth.mockImplementation((_budget: string, month: string) => {
      if (month === '2024-04-01') {
        return Promise.resolve(monthWith([]));
      }
      return Promise.resolve(
        monthWith([
          { id: 'cat-hidden-ggg', name: 'Hidden', activity: -50000, budgeted: 0, hidden: true },
          { id: 'cat-rta-iii', name: 'Inflow: Ready to Assign', activity: -50000, budgeted: 0 },
        ])
      );
    });

    const result = JSON.parse(
      await handleBudgetSuggestions({ months: 1 }, mockClient as never)
    );

    expect(result.summary.categories_analyzed).toBe(0);
  });

  it('defaults to 3 months when months arg omitted', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith([]));

    const result = JSON.parse(await handleBudgetSuggestions({}, mockClient as never));

    expect(result.analysis_period.months_requested).toBe(3);
  });
});
