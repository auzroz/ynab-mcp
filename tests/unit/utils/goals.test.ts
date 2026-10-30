import { describe, it, expect } from 'vitest';
import { buildGoalDetail, decodeGoalDay, getGoalPeriod } from '../../../src/utils/goals.js';

describe('getGoalPeriod', () => {
  it('decodes monthly, weekly and yearly with frequency', () => {
    expect(getGoalPeriod(1, 1)?.label).toBe('monthly');
    expect(getGoalPeriod(1, 2)?.label).toBe('every 2 months');
    expect(getGoalPeriod(2, 1)?.label).toBe('weekly');
    expect(getGoalPeriod(2, 2)?.label).toBe('every 2 weeks');
    expect(getGoalPeriod(13, 1)?.label).toBe('yearly');
    expect(getGoalPeriod(13, 3)?.label).toBe('every 3 years');
  });

  it('decodes fixed multi-month cadences and ignores frequency', () => {
    expect(getGoalPeriod(3, 5)?.label).toBe('every 2 months');
    expect(getGoalPeriod(12, 1)?.label).toBe('every 11 months');
    expect(getGoalPeriod(14, 9)?.label).toBe('every 2 years');
    expect(getGoalPeriod(14, 9)?.monthsPerPeriod.toNumber()).toBe(24);
  });

  it('returns null for no cadence or unknown values', () => {
    expect(getGoalPeriod(0, 1)).toBeNull();
    expect(getGoalPeriod(null, 1)).toBeNull();
    expect(getGoalPeriod(undefined, undefined)).toBeNull();
    expect(getGoalPeriod(99, 1)).toBeNull();
  });
});

describe('decodeGoalDay', () => {
  it('decodes weekday for weekly cadence', () => {
    expect(decodeGoalDay(0, 2)).toEqual({ kind: 'weekday', value: 0, label: 'Sunday' });
    expect(decodeGoalDay(6, 2)).toEqual({ kind: 'weekday', value: 6, label: 'Saturday' });
    expect(decodeGoalDay(7, 2)).toBeNull();
    expect(decodeGoalDay(null, 2)).toBeNull();
  });

  it('decodes day of month for other cadences', () => {
    expect(decodeGoalDay(1, 1)).toEqual({ kind: 'day_of_month', value: 1, label: '1st of the month' });
    expect(decodeGoalDay(22, 13)?.label).toBe('22nd of the month');
    expect(decodeGoalDay(23, 1)?.label).toBe('23rd of the month');
    expect(decodeGoalDay(11, 1)?.label).toBe('11th of the month');
    expect(decodeGoalDay(31, 1)?.value).toBe(31);
    expect(decodeGoalDay(32, 1)).toBeNull();
  });

  it('treats null/missing day as the last day of the month', () => {
    expect(decodeGoalDay(null, 1)).toEqual({
      kind: 'last_day_of_month',
      value: null,
      label: 'last day of the month',
    });
    expect(decodeGoalDay(undefined, 14)?.kind).toBe('last_day_of_month');
  });

  it('returns null when the goal has no repeating cadence', () => {
    expect(decodeGoalDay(null, 0)).toBeNull();
    expect(decodeGoalDay(5, null)).toBeNull();
  });
});

describe('buildGoalDetail', () => {
  it('returns null without a goal type', () => {
    expect(buildGoalDetail({ goal_type: null })).toBeNull();
    expect(buildGoalDetail({})).toBeNull();
  });

  it('decodes a full recurring goal', () => {
    const goal = buildGoalDetail({
      goal_type: 'NEED',
      goal_target: 1200000,
      goal_needs_whole_amount: true,
      goal_cadence: 13,
      goal_cadence_frequency: 1,
      goal_day: 15,
      goal_creation_month: '2024-01-01',
      goal_snoozed_at: '2024-03-02T10:00:00Z',
      goal_percentage_complete: 25,
      goal_months_to_budget: 4,
      goal_under_funded: 100000,
      goal_overall_funded: 300000,
      goal_overall_left: 900000,
    });
    expect(goal).toMatchObject({
      type: 'NEED',
      type_label: 'Spending Target',
      target: '$1200.00',
      target_milliunits: 1200000,
      needs_whole_amount: true,
      cadence: { period: 'yearly', months_per_period: 12 },
      due_day: { kind: 'day_of_month', value: 15 },
      snoozed: true,
      snoozed_at: '2024-03-02T10:00:00Z',
      created_month: '2024-01-01',
      percentage_complete: 25,
      under_funded: '$100.00',
      under_funded_milliunits: 100000,
      overall_funded: '$300.00',
      overall_funded_milliunits: 300000,
      overall_left: '$900.00',
      overall_left_milliunits: 900000,
    });
  });

  it('rounds weekly months-per-period and keeps null fields for a plain target', () => {
    const weekly = buildGoalDetail({ goal_type: 'MF', goal_cadence: 2, goal_cadence_frequency: 1, goal_day: 5 });
    expect(weekly?.cadence).toEqual({ period: 'weekly', months_per_period: 0.2308 });
    expect(weekly?.due_day).toMatchObject({ kind: 'weekday', label: 'Friday' });

    const tb = buildGoalDetail({ goal_type: 'TB', goal_target: 5000 });
    expect(tb).toMatchObject({ cadence: null, due_day: null, snoozed: false, target_date: null, under_funded: null });
  });

  it('prefers goal_target_date over the deprecated goal_target_month', () => {
    const goal = buildGoalDetail({ goal_type: 'TBD', goal_target_date: '2025-01-01', goal_target_month: '2024-12-01' });
    expect(goal).toMatchObject({ target_date: '2025-01-01', target_month: '2025-01-01' });
  });
});
