/**
 * Update Category Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUpdateCategory } from '../../../../src/tools/categories/update-category.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const CATEGORY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MONTH = '2024-01-01';

function updatedCategoryResponse() {
  return {
    data: {
      category: {
        id: CATEGORY_ID,
        name: 'Groceries',
        budgeted: 500000,
        activity: -200000,
        balance: 300000,
      },
    },
  };
}

describe('handleUpdateCategory', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('updates the budgeted amount converting dollars to milliunits', async () => {
    mockClient.updateMonthCategory.mockResolvedValue(updatedCategoryResponse());

    const result = await handleUpdateCategory(
      { month: MONTH, category_id: CATEGORY_ID, budgeted: 500 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.updateMonthCategory).toHaveBeenCalledWith(
      'test-budget-id',
      MONTH,
      CATEGORY_ID,
      { category: { budgeted: 500000 } }
    );
    expect(parsed.success).toBe(true);
    expect(parsed.month).toBe(MONTH);
    expect(parsed.category.budgeted).toBe('$500.00');
    expect(parsed.message).toContain('$500.00');
  });

  it('handles fractional dollar amounts', async () => {
    mockClient.updateMonthCategory.mockResolvedValue(updatedCategoryResponse());

    await handleUpdateCategory(
      { month: MONTH, category_id: CATEGORY_ID, budgeted: 42.5 },
      mockClient as never
    );

    expect(mockClient.updateMonthCategory).toHaveBeenCalledWith(
      'test-budget-id',
      MONTH,
      CATEGORY_ID,
      { category: { budgeted: 42500 } }
    );
  });

  it('rejects an invalid month format', async () => {
    await expect(
      handleUpdateCategory(
        { month: '2024-01', category_id: CATEGORY_ID, budgeted: 100 },
        mockClient as never
      )
    ).rejects.toThrow();
  });

  it('respects budget_id parameter', async () => {
    mockClient.updateMonthCategory.mockResolvedValue(updatedCategoryResponse());

    await handleUpdateCategory(
      { month: MONTH, category_id: CATEGORY_ID, budgeted: 100, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
