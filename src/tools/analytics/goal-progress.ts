/**
 * Goal Progress Tool
 *
 * Tracks progress on all category goals with projections.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { indexCategoryGroups } from '../../utils/categories.js';
import DecimalJS from 'decimal.js';

const Decimal = DecimalJS.default ?? DecimalJS;

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  filter: z
    .enum(['all', 'on_track', 'behind', 'underfunded', 'complete', 'snoozed'])
    .optional()
    .describe('Filter goals by status (default: all)'),
});

// Tool definition
export const goalProgressTool: Tool = {
  name: 'ynab_goal_progress',
  description: `Track progress on all category goals.

Use when the user asks:
- "How are my goals doing?"
- "Show goal progress"
- "Which goals need more funding?"
- "Am I on track with my savings goals?"
- "What goals are behind?"

Returns goal progress, funding status, and projections for each category with a goal.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      filter: {
        type: 'string',
        enum: ['all', 'on_track', 'behind', 'underfunded', 'complete', 'snoozed'],
        description: 'Filter goals by status',
      },
    },
    required: [],
  },
};

interface GoalInfo {
  category_name: string;
  group_name: string;
  goal_type: string;
  goal_type_label: string;
  target_amount: string | null;
  target_date: string | null;
  period: string | null;
  monthly_equivalent: string | null;
  snoozed: boolean;
  current_balance: string;
  percent_complete: number | null;
  underfunded: string;
  underfunded_raw: number;
  status: 'on_track' | 'behind' | 'underfunded' | 'complete' | 'snoozed';
  status_message: string;
  days_until_target: number | null;
}

// Goal type labels
const goalTypeLabels: Record<string, string> = {
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

interface GoalPeriod {
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

// Goal types whose goal_target is an amount per repeat period
const PER_PERIOD_GOAL_TYPES = new Set(['MF', 'NEED', 'DEBT']);

// Handler function
/**
 * Handler for the ynab_goal_progress tool.
 */
export async function handleGoalProgress(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const currentMonth = getCurrentMonth();
  const filter = validated.filter ?? 'all';

  // Get month data and categories
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, currentMonth),
    client.getCategories(budgetId),
  ]);

  const monthData = monthResponse.data.month;

  // Build group lookup
  const { names: groupLookup, internalIds } = indexCategoryGroups(categoriesResponse.data.category_groups);

  // Find categories with goals
  const goalsInfo: GoalInfo[] = [];

  for (const category of monthData.categories) {
    // Skip categories without goals or hidden categories
    if (!category.goal_type || category.hidden) {
      continue;
    }

    const groupName = groupLookup.get(category.id) ?? 'Other';
    if (internalIds.has(category.id)) {
      continue;
    }

    const goalType = category.goal_type;
    const targetAmount = category.goal_target ?? null;
    const targetDate = category.goal_target_date ?? category.goal_target_month ?? null;
    const period = getGoalPeriod(category.goal_cadence, category.goal_cadence_frequency);
    // Per-month equivalent of a recurring target (e.g. a yearly NEED target / 12)
    const monthlyEquivalent =
      period !== null && targetAmount !== null && PER_PERIOD_GOAL_TYPES.has(String(goalType))
        ? new Decimal(targetAmount).dividedBy(period.monthsPerPeriod).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
        : null;
    const snoozed = Boolean(category.goal_snoozed_at);
    const underfunded = category.goal_under_funded ?? 0;
    const balance = category.balance;

    // Calculate percent complete
    let percentComplete: number | null = null;
    if (targetAmount !== null && targetAmount > 0) {
      percentComplete = Math.round((balance / targetAmount) * 100);
    }

    // Calculate days until target (signed: positive = future, negative = past)
    let daysUntilTarget: number | null = null;
    if (targetDate) {
      const todayDate = new Date();
      todayDate.setUTCHours(0, 0, 0, 0);
      const targetDateObj = new Date(targetDate + 'T00:00:00Z');
      const diffMs = targetDateObj.getTime() - todayDate.getTime();
      daysUntilTarget = Math.round(diffMs / (1000 * 60 * 60 * 24));
    }

    // Determine status
    let status: GoalInfo['status'];
    let statusMessage: string;

    if (snoozed) {
      // Snoozed targets are paused for this month: never underfunded or at risk
      status = 'snoozed';
      statusMessage = 'Snoozed, not counted toward underfunded totals';
    } else if (percentComplete !== null && percentComplete >= 100) {
      status = 'complete';
      statusMessage = 'Goal fully funded';
    } else if (targetDate && daysUntilTarget !== null && daysUntilTarget <= 0) {
      // Handle past-due goals explicitly
      status = 'behind';
      if (daysUntilTarget === 0) {
        statusMessage = `Due today, ${percentComplete ?? 0}% complete`;
      } else {
        const daysOverdue = Math.abs(daysUntilTarget);
        statusMessage = `${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue, ${percentComplete ?? 0}% complete`;
      }
    } else if (underfunded > 0) {
      status = 'underfunded';
      statusMessage = `Needs ${formatCurrency(underfunded)} more this month`;
    } else if (targetDate && daysUntilTarget !== null && daysUntilTarget < 30 && (percentComplete ?? 0) < 90) {
      status = 'behind';
      statusMessage = `Only ${daysUntilTarget} days left, ${percentComplete ?? 0}% complete`;
    } else {
      status = 'on_track';
      statusMessage = 'On track';
    }

    const goalTypeStr = String(goalType);
    goalsInfo.push({
      category_name: sanitizeName(category.name),
      group_name: sanitizeName(groupName),
      goal_type: goalTypeStr,
      goal_type_label: goalTypeLabels[goalTypeStr] ?? goalTypeStr,
      target_amount: targetAmount !== null ? formatCurrency(targetAmount) : null,
      target_date: targetDate,
      period: period?.label ?? null,
      monthly_equivalent: monthlyEquivalent !== null ? formatCurrency(monthlyEquivalent) : null,
      snoozed,
      current_balance: formatCurrency(balance),
      percent_complete: percentComplete,
      underfunded: formatCurrency(underfunded),
      underfunded_raw: underfunded,
      status,
      status_message: statusMessage,
      days_until_target: daysUntilTarget,
    });
  }

  // Apply filter
  let filteredGoals = goalsInfo;
  if (filter !== 'all') {
    filteredGoals = goalsInfo.filter((g) => g.status === filter);
  }

  // Sort by status priority (underfunded first, then behind, then on_track, then complete)
  const statusPriority: Record<string, number> = {
    underfunded: 0,
    behind: 1,
    on_track: 2,
    complete: 3,
    snoozed: 4,
  };
  filteredGoals.sort((a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99));

  // Calculate summary stats
  // Snoozed goals are excluded from underfunded/at-risk totals
  const totalUnderfunded = goalsInfo.reduce(
    (sum, g) => (g.snoozed ? sum : sum + g.underfunded_raw),
    0
  );

  const statusCounts = { complete: 0, on_track: 0, behind: 0, underfunded: 0, snoozed: 0 };
  for (const g of goalsInfo) {
    statusCounts[g.status]++;
  }

  // Determine overall status
  let overallStatus: 'healthy' | 'attention_needed' | 'critical';
  let overallMessage: string;

  const activeGoalCount = goalsInfo.length - statusCounts.snoozed;

  if (goalsInfo.length === 0) {
    overallStatus = 'healthy';
    overallMessage = 'No goals configured';
  } else if (statusCounts.underfunded === 0 && statusCounts.behind === 0) {
    overallStatus = 'healthy';
    overallMessage = 'All goals are on track or complete';
  } else if (statusCounts.underfunded > activeGoalCount / 2) {
    overallStatus = 'critical';
    overallMessage = `${statusCounts.underfunded} goals need funding`;
  } else {
    overallStatus = 'attention_needed';
    overallMessage = `${statusCounts.underfunded + statusCounts.behind} goals need attention`;
  }

  return JSON.stringify(
    {
      status: overallStatus,
      message: overallMessage,
      month: currentMonth,
      summary: {
        total_goals: goalsInfo.length,
        complete: statusCounts.complete,
        on_track: statusCounts.on_track,
        behind: statusCounts.behind,
        underfunded: statusCounts.underfunded,
        snoozed: statusCounts.snoozed,
        total_underfunded: formatCurrency(totalUnderfunded),
      },
      goals: filteredGoals.map((g) => ({
        category: g.category_name,
        group: g.group_name,
        type: g.goal_type_label,
        target: g.target_amount,
        target_date: g.target_date,
        balance: g.current_balance,
        progress: g.percent_complete !== null ? `${g.percent_complete}%` : null,
        underfunded: g.underfunded,
        period: g.period,
        monthly_equivalent: g.monthly_equivalent,
        snoozed: g.snoozed,
        status: g.status,
        status_message: g.status_message,
      })),
      filter_applied: filter,
      tips:
        statusCounts.underfunded > 0
          ? [
              `Fund ${statusCounts.underfunded} underfunded goals to stay on track`,
              'Consider adjusting goal targets if consistently underfunded',
              'Use Ready to Assign to cover underfunded goals',
            ]
          : [],
    },
    null,
    2
  );
}
