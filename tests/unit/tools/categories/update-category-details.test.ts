/**
 * Update Category Details Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleUpdateCategoryDetails,
  updateCategoryDetailsTool,
} from '../../../../src/tools/categories/update-category-details.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const CAT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const GROUP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const INTERNAL_GROUP_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function updatedResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      category: {
        id: CAT_ID,
        name: 'Pet Care',
        category_group_id: GROUP_ID,
        note: 'For the dog',
        goal_target: 5000,
        goal_target_date: null,
        goal_needs_whole_amount: null,
        ...overrides,
      },
    },
  };
}

describe('handleUpdateCategoryDetails', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.updateCategory.mockResolvedValue(updatedResponse());
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [
          { id: GROUP_ID, name: 'Pets', categories: [] },
          { id: INTERNAL_GROUP_ID, name: 'Internal Master Category', categories: [] },
        ],
      },
    });
  });

  it('renames a category', async () => {
    const result = JSON.parse(
      await handleUpdateCategoryDetails({ category_id: CAT_ID, name: 'Pet Care' }, mockClient as never)
    );
    expect(mockClient.updateCategory).toHaveBeenCalledWith('test-budget-id', CAT_ID, {
      category: { name: 'Pet Care' },
    });
    expect(mockClient.getCategories).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.updated_fields).toEqual(['name']);
    expect(result.category.name).toBe('Pet Care');
    expect(result.category.note).toBe('For the dog');
  });

  it('sets a note and clears it with null or empty string', async () => {
    await handleUpdateCategoryDetails({ category_id: CAT_ID, note: 'hello' }, mockClient as never);
    expect(mockClient.updateCategory).toHaveBeenLastCalledWith('test-budget-id', CAT_ID, {
      category: { note: 'hello' },
    });
    await handleUpdateCategoryDetails({ category_id: CAT_ID, note: null }, mockClient as never);
    expect(mockClient.updateCategory).toHaveBeenLastCalledWith('test-budget-id', CAT_ID, {
      category: { note: null },
    });
    await handleUpdateCategoryDetails({ category_id: CAT_ID, note: '' }, mockClient as never);
    expect(mockClient.updateCategory).toHaveBeenLastCalledWith('test-budget-id', CAT_ID, {
      category: { note: null },
    });
  });

  it('moves a category to another group', async () => {
    await handleUpdateCategoryDetails(
      { category_id: CAT_ID, category_group_id: GROUP_ID },
      mockClient as never
    );
    expect(mockClient.updateCategory).toHaveBeenCalledWith('test-budget-id', CAT_ID, {
      category: { category_group_id: GROUP_ID },
    });
  });

  it('rejects moving into an internal group without calling the update', async () => {
    await expect(
      handleUpdateCategoryDetails(
        { category_id: CAT_ID, category_group_id: INTERNAL_GROUP_ID },
        mockClient as never
      )
    ).rejects.toThrow(/internal/i);
    expect(mockClient.updateCategory).not.toHaveBeenCalled();
  });

  it('sets and clears target fields', async () => {
    await handleUpdateCategoryDetails(
      {
        category_id: CAT_ID,
        goal_target: 20000,
        goal_target_date: '2027-01-01',
        goal_needs_whole_amount: true,
      },
      mockClient as never
    );
    expect(mockClient.updateCategory).toHaveBeenLastCalledWith('test-budget-id', CAT_ID, {
      category: { goal_target: 20000, goal_target_date: '2027-01-01', goal_needs_whole_amount: true },
    });
    await handleUpdateCategoryDetails(
      { category_id: CAT_ID, goal_target: null, goal_target_date: null },
      mockClient as never
    );
    expect(mockClient.updateCategory).toHaveBeenLastCalledWith('test-budget-id', CAT_ID, {
      category: { goal_target: null, goal_target_date: null },
    });
  });

  it('respects budget_id', async () => {
    await handleUpdateCategoryDetails(
      { category_id: CAT_ID, name: 'X', budget_id: 'custom' },
      mockClient as never
    );
    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom');
  });

  it('sanitizes names and notes in the response', async () => {
    mockClient.updateCategory.mockResolvedValue(
      updatedResponse({ name: 'Bad\u0000Name', note: 'Note\u0007' })
    );
    const result = JSON.parse(
      await handleUpdateCategoryDetails({ category_id: CAT_ID, name: 'x' }, mockClient as never)
    );
    expect(result.category.name).toBe('BadName');
    expect(result.category.note).toBe('Note');
  });

  it.each([
    ['no updatable field', {}],
    ['budget_id only', { budget_id: 'last-used' }],
    ['empty name', { name: '' }],
    ['over-long name', { name: 'x'.repeat(201) }],
    ['over-long note', { note: 'x'.repeat(501) }],
    ['bad category id', { category_id: 'nope', name: 'X' }],
    ['bad group id', { category_group_id: 'nope' }],
    ['negative target', { goal_target: -1 }],
    ['impossible date', { goal_target_date: '2027-02-31' }],
  ])('rejects %s', async (_label, extra) => {
    await expect(
      handleUpdateCategoryDetails({ category_id: CAT_ID, ...extra }, mockClient as never)
    ).rejects.toThrow();
    expect(mockClient.updateCategory).not.toHaveBeenCalled();
  });

  it('requires at least one field with a clear message', async () => {
    await expect(
      handleUpdateCategoryDetails({ category_id: CAT_ID }, mockClient as never)
    ).rejects.toThrow(/at least one field/);
  });

  it('declares caps and nullable clears in the JSON schema', () => {
    const props = updateCategoryDetailsTool.inputSchema.properties as Record<string, any>;
    expect(props.name.maxLength).toBe(200);
    expect(props.note.maxLength).toBe(500);
    expect(props.note.type).toEqual(['string', 'null']);
    expect(updateCategoryDetailsTool.inputSchema.required).toEqual(['category_id']);
    expect(updateCategoryDetailsTool.description).toContain('ynab_update_category');
  });
});
