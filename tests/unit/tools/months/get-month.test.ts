/**
 * Get Month Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetMonth } from '../../../../src/tools/months/get-month.js';
import {
  createMockClient,
  createMonthResponse,
  createCategoriesResponse,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleGetMonth', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  it('returns month summary and categories grouped', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse());

    const result = await handleGetMonth({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.month).toBe('2024-01-01');
    expect(parsed.summary.income).toContain('$');
    expect(parsed.summary.budgeted).toContain('$');
    expect(parsed.summary.age_of_money).toBe(45);
    expect(parsed.category_count).toBeGreaterThan(0);
    expect(parsed.categories_by_group).toBeInstanceOf(Array);
    expect(parsed.categories_by_group[0]).toHaveProperty('group_name');
    expect(parsed.categories_by_group[0]).toHaveProperty('categories');
  });

  it('calls both getBudgetMonth and getCategories with the resolved budget', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse());

    await handleGetMonth({ budget_id: 'b-3', month: '2024-01-01' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-3');
    expect(mockClient.getBudgetMonth).toHaveBeenCalledWith('b-3', '2024-01-01');
    expect(mockClient.getCategories).toHaveBeenCalledWith('b-3');
  });

  it('converts "current" to an actual month date', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse());

    await handleGetMonth({ month: 'current' }, mockClient as never);

    const calledMonth = mockClient.getBudgetMonth.mock.calls[0][1] as string;
    expect(calledMonth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calledMonth).not.toBe('current');
  });

  it('sorts groups alphabetically by group name', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse());

    const result = await handleGetMonth({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    const names = parsed.categories_by_group.map((g: { group_name: string }) => g.group_name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('handles a month with no categories', async () => {
    const emptyMonth = { ...mockMonthDetail, categories: [] };
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(emptyMonth));

    const result = await handleGetMonth({ month: '2024-01-01' }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.category_count).toBe(0);
    expect(parsed.categories_by_group).toEqual([]);
  });
});
