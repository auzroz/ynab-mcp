/**
 * Update Category Group Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUpdateCategoryGroup } from '../../../../src/tools/categories/update-category-group.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const GROUP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function updatedGroupResponse() {
  return {
    data: {
      category_group: {
        id: GROUP_ID,
        name: 'Renamed Group',
      },
    },
  };
}

describe('handleUpdateCategoryGroup', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('renames a category group', async () => {
    mockClient.updateCategoryGroup.mockResolvedValue(updatedGroupResponse());

    const result = await handleUpdateCategoryGroup(
      { category_group_id: GROUP_ID, name: 'Renamed Group' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.updateCategoryGroup).toHaveBeenCalledWith('test-budget-id', GROUP_ID, {
      category_group: { name: 'Renamed Group' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.category_group.id).toBe(GROUP_ID);
    expect(parsed.category_group.name).toBe('Renamed Group');
    expect(parsed.message).toContain('Renamed Group');
  });

  it('rejects an empty name', async () => {
    await expect(
      handleUpdateCategoryGroup({ category_group_id: GROUP_ID, name: '' }, mockClient as never)
    ).rejects.toThrow();
  });

  it('respects budget_id parameter', async () => {
    mockClient.updateCategoryGroup.mockResolvedValue(updatedGroupResponse());

    await handleUpdateCategoryGroup(
      { category_group_id: GROUP_ID, name: 'X', budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
