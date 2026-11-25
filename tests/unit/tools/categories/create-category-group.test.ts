/**
 * Create Category Group Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateCategoryGroup as rawHandleCreateCategoryGroup, createCategoryGroupOutputSchema } from '../../../../src/tools/categories/create-category-group.js';
import { validating } from '../output-validation.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleCreateCategoryGroup = validating(createCategoryGroupOutputSchema, rawHandleCreateCategoryGroup);

function createdGroupResponse() {
  return {
    data: {
      category_group: {
        id: 'new-group-001',
        name: 'Fun Money',
      },
    },
  };
}

describe('handleCreateCategoryGroup', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates a category group', async () => {
    mockClient.createCategoryGroup.mockResolvedValue(createdGroupResponse());

    const parsed = await handleCreateCategoryGroup({ name: 'Fun Money' }, mockClient as never);

    expect(mockClient.createCategoryGroup).toHaveBeenCalledWith('test-budget-id', {
      category_group: { name: 'Fun Money' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.category_group.id).toBe('new-group-001');
    expect(parsed.category_group.name).toBe('Fun Money');
  });

  it('rejects an empty name', async () => {
    await expect(handleCreateCategoryGroup({ name: '' }, mockClient as never)).rejects.toThrow();
  });

  it('respects budget_id parameter', async () => {
    mockClient.createCategoryGroup.mockResolvedValue(createdGroupResponse());

    await handleCreateCategoryGroup(
      { name: 'Fun Money', budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget', { fresh: true });
  });
});
