import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGoalProgress } from '../../../../src/tools/analytics/goal-progress.js';
import { createMockClient, type MockClient } from '../fixtures/mock-client.js';

describe('handleGoalProgress', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    mockClient = createMockClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return empty goals array when no goals exist', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.goals).toEqual([]);
    expect(result.summary.total_goals).toBe(0);
  });

  it('should mark goals as complete when 100% funded', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Emergency Fund',
            goal_type: 'TB',
            goal_target: 1000000,
            balance: 1000000,
            budgeted: 100000,
            activity: 0,
            goal_under_funded: 0,
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
          name: 'Savings',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Emergency Fund', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.goals[0].status).toBe('complete');
    expect(result.goals[0].progress).toBe('100%');
  });

  it('should mark goals as underfunded when goal_under_funded > 0', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Vacation',
            goal_type: 'TBD',
            goal_target: 500000,
            goal_target_month: '2026-06-01',
            balance: 200000,
            budgeted: 50000,
            activity: 0,
            goal_under_funded: 50000,
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
          name: 'Savings',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Vacation', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.goals[0].status).toBe('underfunded');
    expect(result.goals[0].status_message).toContain('$50.00');
  });

  it('should filter goals by status when filter is provided', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Emergency Fund',
              goal_type: 'TB',
              goal_target: 1000000,
              balance: 1000000,
              budgeted: 0,
              activity: 0,
              goal_under_funded: 0,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'cat-2',
              name: 'Vacation',
              goal_type: 'TB',
              goal_target: 500000,
              balance: 200000,
              budgeted: 0,
              activity: 0,
              goal_under_funded: 50000,
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
          name: 'Savings',
          hidden: false,
          deleted: false,
          categories: [
            { id: 'cat-1', name: 'Emergency Fund', hidden: false, deleted: false },
            { id: 'cat-2', name: 'Vacation', hidden: false, deleted: false },
          ],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({ filter: 'underfunded' }, mockClient as any));

    expect(result.goals.length).toBe(1);
    expect(result.goals[0].category).toBe('Vacation');
    expect(result.filter_applied).toBe('underfunded');
  });

  it('should skip hidden categories', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Hidden Goal',
            goal_type: 'TB',
            goal_target: 100000,
            balance: 50000,
            budgeted: 0,
            activity: 0,
            goal_under_funded: 0,
            hidden: true,
            category_group_id: 'group-1',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'group-1',
          name: 'Savings',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Hidden Goal', hidden: true, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.goals.length).toBe(0);
  });

  it('should skip Internal Master Category', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Inflow: Ready to Assign',
            goal_type: 'TB',
            goal_target: 100000,
            balance: 50000,
            budgeted: 0,
            activity: 0,
            goal_under_funded: 0,
            hidden: false,
            category_group_id: 'internal-group',
          }],
        },
      },
    });
    mockClient.getCategories.mockResolvedValue({
      data: {
        category_groups: [{
          id: 'internal-group',
          name: 'Internal Master Category',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Inflow: Ready to Assign', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.goals.length).toBe(0);
  });

  it('should calculate correct progress percentage', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [{
            id: 'cat-1',
            name: 'Car Fund',
            goal_type: 'TB',
            goal_target: 1000000,
            balance: 250000,
            budgeted: 50000,
            activity: 0,
            goal_under_funded: 0,
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
          name: 'Savings',
          hidden: false,
          deleted: false,
          categories: [{ id: 'cat-1', name: 'Car Fund', hidden: false, deleted: false }],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.goals[0].progress).toBe('25%');
  });

  it('should provide overall status summary', async () => {
    mockClient.getBudgetMonth.mockResolvedValue({
      data: {
        month: {
          month: '2026-01-01',
          categories: [
            {
              id: 'cat-1',
              name: 'Emergency Fund',
              goal_type: 'TB',
              goal_target: 1000000,
              balance: 1000000,
              budgeted: 0,
              activity: 0,
              goal_under_funded: 0,
              hidden: false,
              category_group_id: 'group-1',
            },
            {
              id: 'cat-2',
              name: 'Vacation',
              goal_type: 'TB',
              goal_target: 500000,
              balance: 400000,
              budgeted: 50000,
              activity: 0,
              goal_under_funded: 0,
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
          name: 'Savings',
          hidden: false,
          deleted: false,
          categories: [
            { id: 'cat-1', name: 'Emergency Fund', hidden: false, deleted: false },
            { id: 'cat-2', name: 'Vacation', hidden: false, deleted: false },
          ],
        }],
      },
    });

    const result = JSON.parse(await handleGoalProgress({}, mockClient as any));

    expect(result.status).toBe('healthy');
    expect(result.message).toBe('All goals are on track or complete');
    expect(result.summary.total_goals).toBe(2);
    expect(result.summary.complete).toBe(1);
    expect(result.summary.on_track).toBe(1);
  });
});
