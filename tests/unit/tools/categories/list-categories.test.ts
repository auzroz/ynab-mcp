/**
 * List Categories Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListCategories } from '../../../../src/tools/categories/list-categories.js';
import {
  createMockClient,
  createCategoriesResponse,
  mockCategoryGroups,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListCategories', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists visible category groups excluding hidden by default', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleListCategories({}, mockClient as never);
    const parsed = JSON.parse(result);

    const names = parsed.category_groups.map((g: { name: string }) => g.name);
    // Internal Master Category and hidden groups should be filtered out
    expect(names).not.toContain('Internal Master Category');
    expect(names).not.toContain('Hidden');
    expect(names).toContain('Bills');
    expect(parsed.summary.group_count).toBeGreaterThan(0);
    expect(mockClient.getCategories).toHaveBeenCalledWith('test-budget-id');
  });

  it('reports summary totals and overspent/underfunded alerts', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleListCategories({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_budgeted).toBeDefined();
    expect(parsed.summary.total_activity).toBeDefined();
    expect(parsed.summary.total_balance).toBeDefined();
    // Dining Out (-75000) and Subscriptions (-15000) are overspent
    expect(parsed.summary.overspent_count).toBeGreaterThanOrEqual(2);
    expect(parsed.alerts.overspent_categories.length).toBe(parsed.summary.overspent_count);
    // Vacation has goal_under_funded > 0
    expect(parsed.summary.underfunded_count).toBeGreaterThanOrEqual(1);
  });

  it('includes hidden categories and groups when requested', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleListCategories({ include_hidden: true }, mockClient as never);
    const parsed = JSON.parse(result);

    const names = parsed.category_groups.map((g: { name: string }) => g.name);
    expect(names).toContain('Internal Master Category');
    expect(names).toContain('Hidden');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    await handleListCategories({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
