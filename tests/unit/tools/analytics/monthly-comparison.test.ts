import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleMonthlyComparison } from '../../../../src/tools/analytics/monthly-comparison.js';
import { createMockClient, type MockClient } from '../fixtures/mock-client.js';

describe('handleMonthlyComparison', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    mockClient = createMockClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle zero spending in previous month', async () => {
    // Current month with spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -25000,
            balance: 25000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    // Previous month with no spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: 0,
            balance: 50000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Groceries', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.message).toContain('from $0');
    expect(result.insights.new_categories).toBe(1);
  });

  it('should identify spending increase correctly', async () => {
    // Current month - more spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -40000,
            balance: 10000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    // Previous month - less spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -25000,
            balance: 25000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Groceries', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.status).toBe('worse');
    expect(result.comparison.spending.direction).toBe('up');
  });

  it('should identify spending decrease correctly', async () => {
    // Current month - less spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -20000,
            balance: 30000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    // Previous month - more spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -40000,
            balance: 10000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Groceries', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.status).toBe('better');
    expect(result.comparison.spending.direction).toBe('down');
  });

  it('should report similar spending when change is small', async () => {
    // Current month
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -25000,
            balance: 25000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    // Previous month - nearly same spending
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: -26000,
            balance: 24000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Groceries', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.status).toBe('similar');
  });

  it('should skip hidden categories', async () => {
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Groceries',
              budgeted: 50000,
              activity: -25000,
              balance: 25000,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'cat-2',
              name: 'Hidden Category',
              budgeted: 100000,
              activity: -50000,
              balance: 50000,
              hidden: true,
              category_group_id: 'group-1',
            },
          ],
        },
      },
    });
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Groceries',
              budgeted: 50000,
              activity: -20000,
              balance: 30000,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'cat-2',
              name: 'Hidden Category',
              budgeted: 100000,
              activity: -30000,
              balance: 70000,
              hidden: true,
              category_group_id: 'group-1',
            },
          ],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [
            { id: 'cat-1', name: 'Groceries', hidden: false, deleted: false },
            { id: 'cat-2', name: 'Hidden Category', hidden: true, deleted: false },
          ],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    // Only the visible category spending should be counted
    expect(result.comparison.spending.this_month).toBe('$25.00');
    expect(result.comparison.spending.last_month).toBe('$20.00');
  });

  it('should skip Internal Master Category', async () => {
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Groceries',
              budgeted: 50000,
              activity: -25000,
              balance: 25000,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'internal-cat',
              name: 'Inflow: Ready to Assign',
              budgeted: 0,
              activity: 100000,
              balance: 100000,
              hidden: false,
              category_group_id: 'internal-group',
            },
          ],
        },
      },
    });
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Groceries',
              budgeted: 50000,
              activity: -20000,
              balance: 30000,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'internal-cat',
              name: 'Inflow: Ready to Assign',
              budgeted: 0,
              activity: 80000,
              balance: 80000,
              hidden: false,
              category_group_id: 'internal-group',
            },
          ],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [
          {
            id: 'group-1',
            name: 'Bills',
            hidden: false,
            deleted: false,
            categories: [{ id: 'cat-1', name: 'Groceries', hidden: false, deleted: false }],
          },
          {
            id: 'internal-group',
            name: 'Internal Master Category',
            hidden: false,
            deleted: false,
            categories: [{ id: 'internal-cat', name: 'Inflow: Ready to Assign', hidden: false, deleted: false }],
          },
        ],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    // Only the regular category spending should be counted
    expect(result.comparison.spending.this_month).toBe('$25.00');
  });

  it('should handle zero spending in both months', async () => {
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: 0,
            balance: 50000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [{
            id: 'cat-1',
            name: 'Groceries',
            budgeted: 50000,
            activity: 0,
            balance: 50000,
            hidden: false,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Groceries', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.status).toBe('similar');
    expect(result.message).toBe('No spending in either month');
  });

  it('should track notable category changes', async () => {
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Groceries',
              budgeted: 50000,
              activity: -80000,
              balance: -30000,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'cat-2',
              name: 'Entertainment',
              budgeted: 20000,
              activity: -5000,
              balance: 15000,
              hidden: false,
              category_group_id: 'group-1',
            },
          ],
        },
      },
    });
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Groceries',
              budgeted: 50000,
              activity: -40000,
              balance: 10000,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'cat-2',
              name: 'Entertainment',
              budgeted: 20000,
              activity: -30000,
              balance: -10000,
              hidden: false,
              category_group_id: 'group-1',
            },
          ],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Bills',
          hidden: false,
          deleted: false,
          categories: [
            { id: 'cat-1', name: 'Groceries', hidden: false, deleted: false },
            { id: 'cat-2', name: 'Entertainment', hidden: false, deleted: false },
          ],
        }],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.notable_changes.biggest_increases.length).toBeGreaterThan(0);
    expect(result.notable_changes.biggest_decreases.length).toBeGreaterThan(0);
    expect(result.notable_changes.biggest_increases[0].category).toBe('Groceries');
    expect(result.notable_changes.biggest_decreases[0].category).toBe('Entertainment');
  });

  it('should include month references in response', async () => {
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2026-01-01',
          categories: [],
        },
      },
    });
    mockClient.getBudgetMonth.mockResolvedValueOnce({
      data: {
        month: {
          month: '2025-12-01',
          categories: [],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [],
      },
    });

    const result = JSON.parse(await handleMonthlyComparison({}, mockClient as any));

    expect(result.months.current).toBe('2026-01-01');
    expect(result.months.previous).toBe('2025-12-01');
  });
});
