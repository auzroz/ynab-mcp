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

  describe('target date resolution', () => {
    async function run(extra: Record<string, unknown>) {
      mockClient.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2026-01-01',
            categories: [{
              id: 'cat-1',
              name: 'Trip',
              goal_type: 'TBD',
              goal_target: 500000,
              balance: 100000,
              budgeted: 0,
              activity: 0,
              goal_under_funded: 0,
              hidden: false,
              category_group_id: 'group-1',
              ...extra,
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
            categories: [{ id: 'cat-1', name: 'Trip', hidden: false, deleted: false }],
          }],
        },
      });
      return JSON.parse(await handleGoalProgress({}, mockClient as any));
    }

    it('uses goal_target_date when only it is set', async () => {
      const result = await run({ goal_target_date: '2020-03-15' });
      expect(result.goals[0].target_date).toBe('2020-03-15');
      expect(result.goals[0].status).toBe('behind');
      expect(result.goals[0].status_message).toContain('overdue');
    });

    it('falls back to goal_target_month when goal_target_date is missing', async () => {
      const result = await run({ goal_target_month: '2020-03-01' });
      expect(result.goals[0].target_date).toBe('2020-03-01');
      expect(result.goals[0].status_message).toContain('overdue');
    });

    it('prefers goal_target_date when both are set', async () => {
      const result = await run({ goal_target_date: '2020-03-15', goal_target_month: '2099-01-01' });
      expect(result.goals[0].target_date).toBe('2020-03-15');
      expect(result.goals[0].status_message).toContain('overdue');
    });
  });

  describe('goal cadence and snoozed targets', () => {
    async function run(extra: Record<string, unknown>) {
      mockClient.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2026-01-01',
            categories: [{
              id: 'cat-1',
              name: 'Insurance',
              goal_type: 'NEED',
              goal_target: 1200000,
              balance: 100000,
              budgeted: 0,
              activity: 0,
              goal_under_funded: 0,
              hidden: false,
              category_group_id: 'group-1',
              ...extra,
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
            categories: [{ id: 'cat-1', name: 'Insurance', hidden: false, deleted: false }],
          }],
        },
      });
      return JSON.parse(await handleGoalProgress({}, mockClient as any));
    }

    it('reports a weekly target and normalises it to a month with 52/12 weeks', async () => {
      const result = await run({ goal_target: 100000, goal_cadence: 2, goal_cadence_frequency: 1 });
      expect(result.goals[0].period).toBe('weekly');
      // 100.00 per week * 52 / 12 = 433.33
      expect(result.goals[0].monthly_equivalent).toBe('$433.33');
    });

    it('reports every other week using goal_cadence_frequency', async () => {
      const result = await run({ goal_target: 100000, goal_cadence: 2, goal_cadence_frequency: 2 });
      expect(result.goals[0].period).toBe('every 2 weeks');
      expect(result.goals[0].monthly_equivalent).toBe('$216.67');
    });

    it('reports every other month (cadence 1, frequency 2) rather than monthly', async () => {
      const result = await run({ goal_type: 'MF', goal_target: 200000, goal_cadence: 1, goal_cadence_frequency: 2 });
      expect(result.goals[0].period).toBe('every 2 months');
      expect(result.goals[0].monthly_equivalent).toBe('$100.00');
    });

    it('reports a plain monthly goal', async () => {
      const result = await run({ goal_type: 'MF', goal_target: 200000, goal_cadence: 1, goal_cadence_frequency: 1 });
      expect(result.goals[0].period).toBe('monthly');
      expect(result.goals[0].monthly_equivalent).toBe('$200.00');
    });

    it('reports a yearly target and divides it by 12', async () => {
      const result = await run({ goal_cadence: 13, goal_cadence_frequency: 1 });
      expect(result.goals[0].period).toBe('yearly');
      expect(result.goals[0].monthly_equivalent).toBe('$100.00');
    });

    it('reports every N years using goal_cadence_frequency for cadence 13', async () => {
      const result = await run({ goal_cadence: 13, goal_cadence_frequency: 3 });
      expect(result.goals[0].period).toBe('every 3 years');
      expect(result.goals[0].monthly_equivalent).toBe('$33.33');
    });

    it('reports every 2 years for cadence 14 and ignores frequency', async () => {
      const result = await run({ goal_target: 2400000, goal_cadence: 14, goal_cadence_frequency: 5 });
      expect(result.goals[0].period).toBe('every 2 years');
      expect(result.goals[0].monthly_equivalent).toBe('$100.00');
    });

    it.each([
      [3, 'every 2 months', '$600.00'],
      [4, 'every 3 months', '$400.00'],
      [12, 'every 11 months', '$109.09'],
    ])('reports cadence %i as %s and ignores frequency', async (cadence, label, monthly) => {
      const result = await run({ goal_cadence: cadence, goal_cadence_frequency: 7 });
      expect(result.goals[0].period).toBe(label);
      expect(result.goals[0].monthly_equivalent).toBe(monthly);
    });

    it('reports no period when the goal has no cadence', async () => {
      const none = await run({ goal_type: 'TB', goal_cadence: 0, goal_cadence_frequency: 1 });
      expect(none.goals[0].period).toBeNull();
      expect(none.goals[0].monthly_equivalent).toBeNull();

      const missing = await run({ goal_type: 'TB' });
      expect(missing.goals[0].period).toBeNull();
      expect(missing.goals[0].monthly_equivalent).toBeNull();
    });

    it('does not treat a target balance with a cadence as a per-period amount', async () => {
      const result = await run({ goal_type: 'TB', goal_cadence: 1, goal_cadence_frequency: 1 });
      expect(result.goals[0].monthly_equivalent).toBeNull();
    });

    it('labels snoozed targets and excludes them from underfunded totals', async () => {
      const result = await run({
        goal_cadence: 1,
        goal_cadence_frequency: 1,
        goal_under_funded: 50000,
        goal_snoozed_at: '2026-01-10T00:00:00Z',
      });
      expect(result.goals[0].snoozed).toBe(true);
      expect(result.goals[0].status).toBe('snoozed');
      expect(result.summary.snoozed).toBe(1);
      expect(result.summary.underfunded).toBe(0);
      expect(result.summary.total_underfunded).toBe('$0.00');
      expect(result.status).toBe('healthy');
      expect(result.tips).toEqual([]);
    });

    it('does not mark overdue snoozed targets as behind', async () => {
      const result = await run({
        goal_type: 'TBD',
        goal_target_date: '2020-03-15',
        goal_snoozed_at: '2026-01-10T00:00:00Z',
      });
      expect(result.goals[0].status).toBe('snoozed');
      expect(result.summary.behind).toBe(0);
    });

    it('keeps a fully funded snoozed target as complete', async () => {
      const result = await run({
        goal_target: 100000,
        balance: 100000,
        goal_snoozed_at: '2026-01-10T00:00:00Z',
      });
      expect(result.goals[0].snoozed).toBe(true);
      expect(result.goals[0].status).toBe('complete');
      expect(result.summary.complete).toBe(1);
      expect(result.summary.snoozed).toBe(0);

      const filtered = JSON.parse(await handleGoalProgress({ filter: 'complete' }, mockClient as any));
      expect(filtered.goals).toHaveLength(1);
    });

    it('keeps a snoozed target with nothing owed as on_track', async () => {
      const result = await run({ goal_snoozed_at: '2026-01-10T00:00:00Z' });
      expect(result.goals[0].snoozed).toBe(true);
      expect(result.goals[0].status).toBe('on_track');
      expect(result.summary.on_track).toBe(1);
    });

    it('leaves snoozed goals that kept their status out of the active-goal count', async () => {
      const base = {
        goal_type: 'NEED', goal_target: 1200000, balance: 100000, budgeted: 0, activity: 0,
        hidden: false, category_group_id: 'group-1',
      };
      mockClient.getBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2026-01-01',
            categories: [
              { ...base, id: 'cat-1', name: 'Insurance', goal_under_funded: 50000 },
              // Snoozed with nothing owed: keeps on_track, but is still paused.
              { ...base, id: 'cat-2', name: 'Gifts', goal_under_funded: 0, goal_snoozed_at: '2026-01-10T00:00:00Z' },
            ],
          },
        },
      });
      mockClient.getCategories.mockResolvedValue({
        data: {
          category_groups: [{
            id: 'group-1', name: 'Bills', hidden: false, deleted: false,
            categories: [
              { id: 'cat-1', name: 'Insurance', hidden: false, deleted: false },
              { id: 'cat-2', name: 'Gifts', hidden: false, deleted: false },
            ],
          }],
        },
      });
      const result = JSON.parse(await handleGoalProgress({}, mockClient as any));
      expect(result.goals.find((g: { category: string }) => g.category === 'Gifts')?.status).toBe('on_track');
      // The only active goal is underfunded, so more than half of the active goals are.
      expect(result.status).toBe('critical');
    });

    it('can filter to snoozed goals and leaves unsnoozed goals unmarked', async () => {
      const active = await run({ goal_under_funded: 50000, goal_snoozed_at: null });
      expect(active.goals[0].snoozed).toBe(false);
      expect(active.goals[0].status).toBe('underfunded');
      expect(active.summary.total_underfunded).toBe('$50.00');

      const filtered = JSON.parse(await handleGoalProgress({ filter: 'snoozed' }, mockClient as any));
      expect(filtered.goals).toEqual([]);
      expect(filtered.filter_applied).toBe('snoozed');
    });
  });
});
