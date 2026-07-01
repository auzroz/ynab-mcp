/**
 * Unused Categories Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUnusedCategories } from '../../../../src/tools/analytics/unused-categories.js';
import {
  createMockClient,
  createTransactionsResponse,
  createCategoriesResponse,
  mockCategoryGroups,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

function tx(categoryId: string, date: string, id: string) {
  return {
    id,
    date,
    amount: -10000,
    payee_id: 'p',
    payee_name: 'Payee',
    category_id: categoryId,
    category_name: 'Cat',
    account_id: 'acct-1',
    transfer_account_id: null,
    deleted: false,
    subtransactions: [],
  };
}

describe('handleUnusedCategories', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('finds categories with no recent activity', async () => {
    // No transactions => every (non-hidden, non-funded) category is unused.
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleUnusedCategories({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_categories).toBeGreaterThan(0);
    expect(parsed.summary.unused_categories).toBeGreaterThan(0);
    expect(parsed.categories.safe_to_remove).toBeInstanceOf(Array);
    expect(parsed.categories.needs_review).toBeInstanceOf(Array);
    expect(parsed.by_group).toBeInstanceOf(Array);
    expect(parsed.tips.length).toBeGreaterThan(0);
  });

  it('marks active categories as used (excludes them)', async () => {
    // Activity in Groceries + Dining => those not flagged unused.
    const txns = [
      tx('cat-groceries-555', '2024-01-10', 'g1'),
      tx('cat-dining-666', '2024-01-12', 'd1'),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleUnusedCategories({}, mockClient as never);
    const parsed = JSON.parse(result);

    const allUnusedNames = parsed.by_group.flatMap(
      (g: { categories: string[] }) => g.categories
    );
    expect(allUnusedNames).not.toContain('Groceries');
    expect(allUnusedNames).not.toContain('Dining Out');
  });

  it('detects activity from split subtransactions', async () => {
    const splitTxn = {
      id: 'split-1',
      date: '2024-01-15',
      amount: -50000,
      payee_id: 'p',
      payee_name: 'Amazon',
      category_id: null,
      category_name: 'Split',
      account_id: 'acct-1',
      transfer_account_id: null,
      deleted: false,
      subtransactions: [
        { id: 's1', category_id: 'cat-entertainment-ccc', amount: -25000, deleted: false },
        { id: 's2', category_id: 'cat-shopping-eee', amount: -25000, deleted: false },
      ],
    };
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([splitTxn] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleUnusedCategories({}, mockClient as never);
    const parsed = JSON.parse(result);

    const allUnusedNames = parsed.by_group.flatMap(
      (g: { categories: string[] }) => g.categories
    );
    expect(allUnusedNames).not.toContain('Entertainment');
    expect(allUnusedNames).not.toContain('Shopping');
  });

  it('include_funded controls whether funded categories appear', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const withoutFunded = JSON.parse(
      await handleUnusedCategories({}, mockClient as never)
    );
    const withFunded = JSON.parse(
      await handleUnusedCategories({ include_funded: true }, mockClient as never)
    );

    // Including funded categories should report at least as many unused.
    expect(withFunded.summary.unused_categories).toBeGreaterThanOrEqual(
      withoutFunded.summary.unused_categories
    );
  });

  it('reports zero unused when all categories are active', async () => {
    // Provide activity for every non-hidden category id.
    const ids = mockCategoryGroups
      .filter((g) => g.name !== 'Internal Master Category' && !g.hidden)
      .flatMap((g) => g.categories.filter((c) => !c.hidden).map((c) => c.id));
    const txns = ids.map((id, i) => tx(id, '2024-01-10', `t-${i}`));
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleUnusedCategories({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.unused_categories).toBe(0);
    expect(parsed.summary.percent_unused).toBe(0);
  });

  it('respects months and budget_id parameters', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleUnusedCategories(
      { months: 3, budget_id: 'custom-budget' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.period.months_checked).toBe(3);
    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
