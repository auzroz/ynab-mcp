/**
 * Create Category Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateCategory } from '../../../../src/tools/categories/create-category.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const GROUP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function createdCategoryResponse() {
  return {
    data: {
      category: {
        id: 'new-cat-001',
        name: 'Pet Supplies',
        category_group_id: GROUP_ID,
      },
    },
  };
}

describe('handleCreateCategory', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates a category in the given group', async () => {
    mockClient.createCategory.mockResolvedValue(createdCategoryResponse());

    const result = await handleCreateCategory(
      { category_group_id: GROUP_ID, name: 'Pet Supplies' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.createCategory).toHaveBeenCalledWith('test-budget-id', {
      category: { name: 'Pet Supplies', category_group_id: GROUP_ID },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.category.id).toBe('new-cat-001');
    expect(parsed.category.name).toBe('Pet Supplies');
  });

  it('includes the note when provided', async () => {
    mockClient.createCategory.mockResolvedValue(createdCategoryResponse());

    await handleCreateCategory(
      { category_group_id: GROUP_ID, name: 'Pet Supplies', note: 'For the dog' },
      mockClient as never
    );

    expect(mockClient.createCategory).toHaveBeenCalledWith('test-budget-id', {
      category: { name: 'Pet Supplies', category_group_id: GROUP_ID, note: 'For the dog' },
    });
  });

  it('respects budget_id parameter', async () => {
    mockClient.createCategory.mockResolvedValue(createdCategoryResponse());

    await handleCreateCategory(
      { category_group_id: GROUP_ID, name: 'Pet Supplies', budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
