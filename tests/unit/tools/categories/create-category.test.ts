/**
 * Create Category Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateCategory } from '../../../../src/tools/categories/create-category.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const GROUP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function createdCategoryResponse(extra: Record<string, unknown> = {}) {
  return {
    data: {
      category: {
        id: 'new-cat-001',
        name: 'Pet Supplies',
        category_group_id: GROUP_ID,
        ...extra,
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

  describe('target fields', () => {
    const base = { category_group_id: GROUP_ID, name: 'Vacation' };

    it('passes goal_target, goal_target_date and goal_needs_whole_amount to the client', async () => {
      mockClient.createCategory.mockResolvedValue(createdCategoryResponse());

      await handleCreateCategory(
        { ...base, goal_target: 250, goal_target_date: '2027-06-01', goal_needs_whole_amount: false },
        mockClient as never
      );

      expect(mockClient.createCategory).toHaveBeenCalledWith('test-budget-id', {
        category: {
          name: 'Vacation',
          category_group_id: GROUP_ID,
          goal_target: 250000,
          goal_target_date: '2027-06-01',
          goal_needs_whole_amount: false,
        },
      });
    });

    it('echoes the stored target with a formatted display value', async () => {
      mockClient.createCategory.mockResolvedValue(
        createdCategoryResponse({ goal_target: 250000 })
      );
      const result = JSON.parse(
        await handleCreateCategory({ ...base, goal_target: 250 }, mockClient as never)
      );
      expect(result.category.goal_target).toBe(250000);
      expect(result.category.goal_target_display).toBe('$250.00');
    });

    it('accepts a zero target', async () => {
      mockClient.createCategory.mockResolvedValue(createdCategoryResponse());
      await handleCreateCategory({ ...base, goal_target: 0 }, mockClient as never);
      expect(mockClient.createCategory).toHaveBeenCalledWith('test-budget-id', {
        category: { name: 'Vacation', category_group_id: GROUP_ID, goal_target: 0 },
      });
    });

    it.each([
      ['negative amount', { goal_target: -1 }],
      ['non-finite amount', { goal_target: Infinity }],
      ['non-numeric amount', { goal_target: '100' }],
      ['bad date format', { goal_target_date: '06/01/2027' }],
      ['impossible date', { goal_target_date: '2027-02-31' }],
      ['null on create', { goal_target: null }],
      ['non-boolean whole amount', { goal_needs_whole_amount: 'yes' }],
    ])('rejects %s', async (_label, extra) => {
      await expect(
        handleCreateCategory({ ...base, ...extra }, mockClient as never)
      ).rejects.toThrow();
      expect(mockClient.createCategory).not.toHaveBeenCalled();
    });
  });

  describe('goal_frequency', () => {
    const gbase = { category_group_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Dining Out' };

    it('passes goal_frequency with a milliunit goal_target', async () => {
      mockClient.createCategory.mockResolvedValue({
        data: { category: { id: 'c', name: 'Dining Out', category_group_id: gbase.category_group_id, goal_target: 50000 } },
      });
      await handleCreateCategory({ ...gbase, goal_target: 50, goal_frequency: 'weekly' }, mockClient as never);
      expect(mockClient.createCategory).toHaveBeenCalledWith(
        'test-budget-id',
        expect.objectContaining({
          category: expect.objectContaining({ goal_target: 50000, goal_frequency: 'weekly' }),
        })
      );
    });

    it.each([
      ['missing goal_target', { goal_frequency: 'weekly' }],
      ['null goal_target', { goal_frequency: 'weekly', goal_target: null }],
      ['goal_target_date', { goal_frequency: 'weekly', goal_target: 50, goal_target_date: '2030-01-01' }],
    ])('rejects %s', async (_label, extra) => {
      await expect(handleCreateCategory({ ...gbase, ...extra }, mockClient as never)).rejects.toThrow();
      expect(mockClient.createCategory).not.toHaveBeenCalled();
    });
  });
});
