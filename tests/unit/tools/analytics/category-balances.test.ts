/**
 * Category Balances Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCategoryBalances } from '../../../../src/tools/analytics/category-balances.js';
import {
  createMockClient,
  createCategoriesResponse,
  createMonthResponse,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

function monthWith(
  categories: Array<{ id: string; name: string; balance: number; budgeted: number; activity: number; hidden?: boolean }>
) {
  return createMonthResponse({
    ...mockMonthDetail,
    categories: categories.map((c) => ({
      ...mockMonthDetail.categories[0]!,
      id: c.id,
      name: c.name,
      balance: c.balance,
      budgeted: c.budgeted,
      activity: c.activity,
      hidden: c.hidden ?? false,
    })),
  });
}

const sampleCategories = [
  { id: 'cat-groceries-555', name: 'Groceries', balance: 150000, budgeted: 600000, activity: -450000 },
  { id: 'cat-dining-666', name: 'Dining Out', balance: -75000, budgeted: 200000, activity: -275000 },
  { id: 'cat-hobbies-fff', name: 'Hobbies', balance: 0, budgeted: 0, activity: 0 },
];

describe('handleCategoryBalances', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    mockClient = createMockClient();
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all categories by default with totals', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    const result = JSON.parse(await handleCategoryBalances({}, mockClient as never));

    expect(result.filter).toBe('none');
    expect(result.summary.categories_shown).toBe(3);
    expect(result.top_balances[0].category).toBe('Groceries'); // sorted highest balance first
  });

  it('filters to negative balances', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    const result = JSON.parse(
      await handleCategoryBalances({ filter: 'negative' }, mockClient as never)
    );

    expect(result.summary.categories_shown).toBe(1);
    expect(result.negative_balances[0].category).toBe('Dining Out');
    expect(result.filter).toContain('filter: negative');
  });

  it('filters to positive balances', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    const result = JSON.parse(
      await handleCategoryBalances({ filter: 'positive' }, mockClient as never)
    );

    expect(result.summary.categories_shown).toBe(1);
    expect(result.top_balances[0].category).toBe('Groceries');
  });

  it('filters to funded categories (budgeted > 0)', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    const result = JSON.parse(
      await handleCategoryBalances({ filter: 'funded' }, mockClient as never)
    );

    expect(result.summary.categories_shown).toBe(2); // Groceries + Dining
  });

  it('filters to unfunded categories (balance 0 and budgeted 0)', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    const result = JSON.parse(
      await handleCategoryBalances({ filter: 'unfunded' }, mockClient as never)
    );

    expect(result.summary.categories_shown).toBe(1); // Hobbies
  });

  it('searches category names (partial match)', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    const result = JSON.parse(
      await handleCategoryBalances({ search: 'din' }, mockClient as never)
    );

    expect(result.summary.categories_shown).toBe(1);
    expect(result.top_balances[0].category).toBe('Dining Out');
    expect(result.filter).toContain('search:');
  });

  it('filters by group name', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(monthWith(sampleCategories));

    // Groceries and Dining belong to 'Everyday Expenses' group via groupLookup
    const result = JSON.parse(
      await handleCategoryBalances({ group: 'everyday' }, mockClient as never)
    );

    expect(result.summary.categories_shown).toBe(2);
    expect(result.filter).toContain('group:');
  });

  it('skips hidden and internal categories', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([
        { id: 'cat-hidden-ggg', name: 'Hidden', balance: 50000, budgeted: 0, activity: 0, hidden: true },
        { id: 'cat-rta-iii', name: 'Inflow: Ready to Assign', balance: 50000, budgeted: 0, activity: 0 },
      ])
    );

    const result = JSON.parse(await handleCategoryBalances({}, mockClient as never));

    expect(result.summary.categories_shown).toBe(0);
  });
});
