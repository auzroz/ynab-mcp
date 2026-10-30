/**
 * Goal (category target) decoding helpers.
 *
 * Shared by ynab_goal_progress and the category tools so that the YNAB
 * goal_cadence / goal_day encodings are interpreted in exactly one place.
 */

import DecimalJS from 'decimal.js';
import { formatCurrency } from './milliunits.js';

const Decimal = DecimalJS.default ?? DecimalJS;

// Goal type labels
export const GOAL_TYPE_LABELS: Record<string, string> = {
  TB: 'Target Balance',
  TBD: 'Target Balance by Date',
  MF: 'Monthly Funding',
  NEED: 'Spending Target',
  DEBT: 'Debt Payoff',
};

// YNAB goal_cadence values with a repeat interval of goal_cadence * goal_cadence_frequency
const CADENCE_MONTHLY = 1;
const CADENCE_WEEKLY = 2;
const CADENCE_YEARLY = 13;
// goal_cadence 14 (every 2 years) ignores goal_cadence_frequency
const CADENCE_EVERY_2_YEARS = 14;

export interface GoalPeriod {
  label: string;
  /** Length of one repeat period in months (weeks are normalised as 12/52 months). */
  monthsPerPeriod: InstanceType<typeof Decimal>;
}

/**
 * Derive a goal's repeat period from goal_cadence and goal_cadence_frequency.
 * Returns null when the goal does not repeat (cadence 0/undefined) or the
 * cadence is not a recognised value.
 */
export function getGoalPeriod(
  cadence: number | null | undefined,
  frequency: number | null | undefined
): GoalPeriod | null {
  if (cadence === null || cadence === undefined || !Number.isInteger(cadence)) return null;

  // Frequency only applies to cadences 1, 2 and 13; treat missing/invalid as 1
  const freq = frequency !== null && frequency !== undefined && Number.isInteger(frequency) && frequency >= 1
    ? frequency
    : 1;

  if (cadence === CADENCE_MONTHLY) {
    return {
      label: freq === 1 ? 'monthly' : `every ${freq} months`,
      monthsPerPeriod: new Decimal(freq),
    };
  }
  if (cadence === CADENCE_WEEKLY) {
    return {
      label: freq === 1 ? 'weekly' : `every ${freq} weeks`,
      monthsPerPeriod: new Decimal(freq).times(12).dividedBy(52),
    };
  }
  if (cadence === CADENCE_YEARLY) {
    return {
      label: freq === 1 ? 'yearly' : `every ${freq} years`,
      monthsPerPeriod: new Decimal(freq).times(12),
    };
  }
  if (cadence >= 3 && cadence <= 12) {
    // 3 = every 2 months ... 12 = every 11 months
    const months = cadence - 1;
    return { label: `every ${months} months`, monthsPerPeriod: new Decimal(months) };
  }
  if (cadence === CADENCE_EVERY_2_YEARS) {
    return { label: 'every 2 years', monthsPerPeriod: new Decimal(24) };
  }
  return null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface GoalDueDay {
  kind: 'weekday' | 'day_of_month' | 'last_day_of_month';
  /** Weekday number (0 = Sunday) or day of month; null for the last day of the month. */
  value: number | null;
  label: string;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Decode goal_day. For weekly cadence (2) it is a weekday (0 = Sunday); for
 * other cadences it is a day of the month (1-31), and null means the last day
 * of the month. Returns null when the goal has no repeating cadence (the due
 * date then comes from the target date) or the value is out of range.
 *
 * Note: the ynab SDK maps a null goal_day to undefined, so a missing day is
 * treated the same as null (last day of month) for monthly-style cadences.
 */
export function decodeGoalDay(
  day: number | null | undefined,
  cadence: number | null | undefined
): GoalDueDay | null {
  if (getGoalPeriod(cadence, 1) === null) return null;

  if (cadence === CADENCE_WEEKLY) {
    if (day === null || day === undefined || !Number.isInteger(day) || day < 0 || day > 6) return null;
    return { kind: 'weekday', value: day, label: WEEKDAYS[day] ?? String(day) };
  }

  if (day === null || day === undefined) {
    return { kind: 'last_day_of_month', value: null, label: 'last day of the month' };
  }
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return { kind: 'day_of_month', value: day, label: `${ordinal(day)} of the month` };
}

/** The subset of a YNAB category (or month category) used to build a goal object. */
export interface GoalSource {
  goal_type?: string | null;
  goal_needs_whole_amount?: boolean | null;
  goal_day?: number | null;
  goal_cadence?: number | null;
  goal_cadence_frequency?: number | null;
  goal_creation_month?: string | null;
  goal_target?: number | null;
  goal_target_month?: string | null;
  goal_target_date?: string | null;
  goal_percentage_complete?: number | null;
  goal_months_to_budget?: number | null;
  goal_under_funded?: number | null;
  goal_overall_funded?: number | null;
  goal_overall_left?: number | null;
  goal_snoozed_at?: string | null;
}

function money(milliunits: number | null | undefined): string | null {
  return milliunits !== null && milliunits !== undefined ? formatCurrency(milliunits) : null;
}

/**
 * Build the decoded goal object returned by the category tools. Returns null
 * when the category has no target. Existing keys (type, target_date,
 * target_month, target, percentage_complete, months_to_budget, under_funded,
 * overall_funded, overall_left) are kept; everything else is additive.
 */
export function buildGoalDetail(category: GoalSource): Record<string, unknown> | null {
  if (!category.goal_type) return null;

  const type = String(category.goal_type);
  // goal_target_month is deprecated (YNAB API 1.78); prefer goal_target_date
  const targetDate = category.goal_target_date ?? category.goal_target_month ?? null;
  const period = getGoalPeriod(category.goal_cadence, category.goal_cadence_frequency);
  const snoozedAt = category.goal_snoozed_at ?? null;

  return {
    type,
    type_label: GOAL_TYPE_LABELS[type] ?? type,
    target_date: targetDate,
    // Backward-compatible alias of target_date
    target_month: targetDate,
    target: money(category.goal_target),
    target_milliunits: category.goal_target ?? null,
    needs_whole_amount: category.goal_needs_whole_amount ?? null,
    cadence: period
      ? {
          period: period.label,
          months_per_period: period.monthsPerPeriod.toDecimalPlaces(4).toNumber(),
        }
      : null,
    due_day: decodeGoalDay(category.goal_day, category.goal_cadence),
    snoozed: Boolean(snoozedAt),
    snoozed_at: snoozedAt,
    created_month: category.goal_creation_month ?? null,
    percentage_complete: category.goal_percentage_complete ?? null,
    months_to_budget: category.goal_months_to_budget ?? null,
    under_funded: money(category.goal_under_funded),
    under_funded_milliunits: category.goal_under_funded ?? null,
    overall_funded: money(category.goal_overall_funded),
    overall_funded_milliunits: category.goal_overall_funded ?? null,
    overall_left: money(category.goal_overall_left),
    overall_left_milliunits: category.goal_overall_left ?? null,
  };
}
