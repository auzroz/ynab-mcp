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

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  filter: z
    .enum(['all', 'on_track', 'behind', 'underfunded', 'complete'])
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
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      filter: {
        type: 'string',
        enum: ['all', 'on_track', 'behind', 'underfunded', 'complete'],
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
  monthly_funding: string | null;
  current_balance: string;
  percent_complete: number | null;
  underfunded: string;
  underfunded_raw: number;
  status: 'on_track' | 'behind' | 'underfunded' | 'complete';
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
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Find categories with goals
  const goalsInfo: GoalInfo[] = [];

  for (const category of monthData.categories) {
    // Skip categories without goals or hidden categories
    if (!category.goal_type || category.hidden) {
      continue;
    }

    const groupName = groupLookup.get(category.id) ?? 'Other';
    if (groupName === 'Internal Master Category') {
      continue;
    }

    const goalType = category.goal_type;
    const targetAmount = category.goal_target ?? null;
    const targetDate = category.goal_target_month ?? null;
    const monthlyFunding = category.goal_cadence_frequency === 1 ? category.goal_target : null;
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

    if (percentComplete !== null && percentComplete >= 100) {
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
      monthly_funding: monthlyFunding !== null && monthlyFunding !== undefined ? formatCurrency(monthlyFunding) : null,
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
  };
  filteredGoals.sort((a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99));

  // Calculate summary stats
  const totalUnderfunded = goalsInfo.reduce(
    (sum, g) => sum + g.underfunded_raw,
    0
  );

  const statusCounts = {
    complete: goalsInfo.filter((g) => g.status === 'complete').length,
    on_track: goalsInfo.filter((g) => g.status === 'on_track').length,
    behind: goalsInfo.filter((g) => g.status === 'behind').length,
    underfunded: goalsInfo.filter((g) => g.status === 'underfunded').length,
  };

  // Determine overall status
  let overallStatus: 'healthy' | 'attention_needed' | 'critical';
  let overallMessage: string;

  if (goalsInfo.length === 0) {
    overallStatus = 'healthy';
    overallMessage = 'No goals configured';
  } else if (statusCounts.underfunded === 0 && statusCounts.behind === 0) {
    overallStatus = 'healthy';
    overallMessage = 'All goals are on track or complete';
  } else if (statusCounts.underfunded > goalsInfo.length / 2) {
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
