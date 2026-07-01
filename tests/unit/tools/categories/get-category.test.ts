/**
 * Get Category Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetCategory } from '../../../../src/tools/categories/get-category.js';
import {
  createMockClient,
  createCategoryResponse,
  mockBillsCategories,
  mockSavingsCategories,
  mockDiscretionaryCategories,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const CATEGORY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('handleGetCategory', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns category with goal details', async () => {
    // Vacation category has a full goal
    mockClient.getCategoryById.mockResolvedValue(
      createCategoryResponse(mockSavingsCategories[1])
    );

    const result = await handleGetCategory({ category_id: CATEGORY_ID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.category.name).toBe('Vacation');
    expect(parsed.category.goal).not.toBeNull();
    expect(parsed.category.goal.type).toBe('TBD');
    expect(parsed.category.goal.target).toBe('$3000.00');
    expect(parsed.category.goal.under_funded).toBe('$300.00');
    expect(mockClient.getCategoryById).toHaveBeenCalledWith('test-budget-id', CATEGORY_ID);
  });

  it('returns null goal for category without a goal type', async () => {
    // Entertainment category has no goal_type
    mockClient.getCategoryById.mockResolvedValue(
      createCategoryResponse(mockDiscretionaryCategories[0])
    );

    const result = await handleGetCategory({ category_id: CATEGORY_ID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.category.name).toBe('Entertainment');
    expect(parsed.category.goal).toBeNull();
  });

  it('formats budgeted, activity and balance', async () => {
    mockClient.getCategoryById.mockResolvedValue(
      createCategoryResponse(mockBillsCategories[0])
    );

    const result = await handleGetCategory({ category_id: CATEGORY_ID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.category.budgeted).toBe('$1500.00');
    expect(parsed.category.activity).toBe('-$1500.00');
    expect(parsed.category.balance).toBe('$0.00');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getCategoryById.mockResolvedValue(
      createCategoryResponse(mockBillsCategories[0])
    );

    await handleGetCategory(
      { category_id: CATEGORY_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
