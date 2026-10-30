/**
 * Get Month Category Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetMonthCategory } from '../../../../src/tools/categories/get-month-category.js';
import {
  createMockClient,
  createCategoryResponse,
  mockBillsCategories,
  mockSavingsCategories,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const CATEGORY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MONTH = '2024-01-01';

describe('handleGetMonthCategory', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns month-specific category details', async () => {
    mockClient.getMonthCategoryById.mockResolvedValue(
      createCategoryResponse(mockBillsCategories[1])
    );

    const result = await handleGetMonthCategory(
      { month: MONTH, category_id: CATEGORY_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.month).toBe(MONTH);
    expect(parsed.category.name).toBe('Utilities');
    expect(parsed.category.budgeted).toBe('$200.00');
    expect(parsed.category.balance).toBe('$25.00');
    expect(mockClient.getMonthCategoryById).toHaveBeenCalledWith(
      'test-budget-id',
      MONTH,
      CATEGORY_ID
    );
  });

  it('includes goal details when present', async () => {
    mockClient.getMonthCategoryById.mockResolvedValue(
      createCategoryResponse(mockSavingsCategories[0])
    );

    const result = await handleGetMonthCategory(
      { month: MONTH, category_id: CATEGORY_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.category.goal).not.toBeNull();
    expect(parsed.category.goal.type).toBe('TB');
  });

  it('rejects an invalid month format', async () => {
    await expect(
      handleGetMonthCategory(
        { month: '2024-01-15', category_id: CATEGORY_ID },
        mockClient as never
      )
    ).rejects.toThrow();
  });

  it('respects budget_id parameter', async () => {
    mockClient.getMonthCategoryById.mockResolvedValue(
      createCategoryResponse(mockBillsCategories[0])
    );

    await handleGetMonthCategory(
      { month: MONTH, category_id: CATEGORY_ID, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });

  describe('goal target date', () => {
    async function goalFor(overrides: Record<string, unknown>) {
      const base = { ...mockSavingsCategories[1], goal_target_month: null, goal_target_date: undefined };
      mockClient.getMonthCategoryById.mockResolvedValue(
        createCategoryResponse({ ...base, ...overrides } as never)
      );
      const result = await handleGetMonthCategory({ month: MONTH, category_id: CATEGORY_ID }, mockClient as never);
      return JSON.parse(result).category.goal;
    }

    it('exposes goal_target_date as target_date', async () => {
      const goal = await goalFor({ goal_target_date: '2025-06-15' });
      expect(goal.target_date).toBe('2025-06-15');
      expect(goal.target_month).toBe('2025-06-15');
    });

    it('falls back to goal_target_month', async () => {
      const goal = await goalFor({ goal_target_month: '2025-06-01' });
      expect(goal.target_date).toBe('2025-06-01');
      expect(goal.target_month).toBe('2025-06-01');
    });

    it('prefers goal_target_date when both are set', async () => {
      const goal = await goalFor({ goal_target_date: '2025-06-15', goal_target_month: '2025-06-01' });
      expect(goal.target_date).toBe('2025-06-15');
    });

    it('returns null when neither is set', async () => {
      const goal = await goalFor({});
      expect(goal.target_date).toBeNull();
    });
  });
});
