/**
 * Spending Pace Tool
 *
 * Tracks daily spending rate and projects end-of-month status.
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
});

// Tool definition
export const spendingPaceTool: Tool = {
  name: 'ynab_spending_pace',
  description: `Track daily spending rate and project end-of-month status.

Use when the user asks:
- "Am I on track this month?"
- "What's my spending pace?"
- "Will I stay within budget?"
- "How much can I spend per day?"
- "Daily spending rate"

Returns current spending rate vs target rate with projections.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
};

interface CategoryPace {
  category_name: string;
  group_name: string;
  budgeted: number;
  spent: number;
  remaining: number;
  daily_target: number;
  daily_actual: number;
  projected_end: number;
  status: 'on_track' | 'ahead' | 'behind' | 'overspent';
}

// Handler function
/**
 * Handler for the ynab_spending_pace tool.
 */
export async function handleSpendingPace(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  // getCurrentMonth() uses UTC internally for consistency with date calculations below
  const currentMonth = getCurrentMonth();

  // Get month data and categories
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, currentMonth),
    client.getCategories(budgetId),
  ]);

  // Build group lookup
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Calculate days in month and days elapsed using UTC to avoid timezone drift
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  const daysRemaining = daysInMonth - dayOfMonth;
  const percentMonthElapsed = (dayOfMonth / daysInMonth) * 100;

  // Process categories
  const categoryPaces: CategoryPace[] = [];
  let totalBudgeted = 0;
  let totalSpent = 0;

  for (const cat of monthResponse.data.month.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    const budgeted = cat.budgeted;
    const spent = cat.activity < 0 ? Math.abs(cat.activity) : 0;
    const remaining = budgeted - spent;

    // Skip categories with no budget and no spending
    if (budgeted === 0 && spent === 0) continue;

    totalBudgeted += budgeted;
    totalSpent += spent;

    // Calculate rates
    const dailyTarget = budgeted / daysInMonth;
    const dailyActual = dayOfMonth > 0 ? spent / dayOfMonth : 0;
    const projectedEnd = dailyActual * daysInMonth;

    // Determine status
    let status: CategoryPace['status'];
    if (spent > budgeted) {
      status = 'overspent';
    } else if (dailyActual > dailyTarget * 1.1) {
      status = 'behind';
    } else if (dailyActual < dailyTarget * 0.9) {
      status = 'ahead';
    } else {
      status = 'on_track';
    }

    categoryPaces.push({
      category_name: sanitizeName(cat.name),
      group_name: sanitizeName(groupName),
      budgeted,
      spent,
      remaining,
      daily_target: dailyTarget,
      daily_actual: dailyActual,
      projected_end: projectedEnd,
      status,
    });
  }

  // Sort by status (overspent first, then behind, etc.)
  const statusPriority: Record<string, number> = {
    overspent: 0,
    behind: 1,
    on_track: 2,
    ahead: 3,
  };
  categoryPaces.sort((a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99));

  // Calculate overall metrics
  const totalRemaining = totalBudgeted - totalSpent;
  const overallDailyTarget = totalBudgeted / daysInMonth;
  const overallDailyActual = dayOfMonth > 0 ? totalSpent / dayOfMonth : 0;
  const projectedTotalSpend = overallDailyActual * daysInMonth;
  const dailyAllowanceRemaining = daysRemaining > 0 ? totalRemaining / daysRemaining : 0;

  // Determine overall status
  let overallStatus: 'on_track' | 'ahead' | 'behind' | 'overspent';
  let overallMessage: string;

  if (totalSpent > totalBudgeted) {
    overallStatus = 'overspent';
    overallMessage = `Already over budget by ${formatCurrency(totalSpent - totalBudgeted)}`;
  } else if (overallDailyActual > overallDailyTarget * 1.1) {
    overallStatus = 'behind';
    const projectedOver = projectedTotalSpend - totalBudgeted;
    overallMessage = `At current pace, will exceed budget by ${formatCurrency(projectedOver)}`;
  } else if (overallDailyActual < overallDailyTarget * 0.9) {
    overallStatus = 'ahead';
    overallMessage = 'Spending below target rate';
  } else {
    overallStatus = 'on_track';
    overallMessage = 'Spending is on pace with budget';
  }

  // Count statuses
  const statusCounts = {
    overspent: categoryPaces.filter((c) => c.status === 'overspent').length,
    behind: categoryPaces.filter((c) => c.status === 'behind').length,
    on_track: categoryPaces.filter((c) => c.status === 'on_track').length,
    ahead: categoryPaces.filter((c) => c.status === 'ahead').length,
  };

  return JSON.stringify(
    {
      status: overallStatus,
      message: overallMessage,
      month: currentMonth,
      progress: {
        day_of_month: dayOfMonth,
        days_in_month: daysInMonth,
        days_remaining: daysRemaining,
        percent_elapsed: `${Math.round(percentMonthElapsed)}%`,
      },
      overall: {
        total_budgeted: formatCurrency(totalBudgeted),
        total_spent: formatCurrency(totalSpent),
        remaining: formatCurrency(totalRemaining),
        percent_spent: totalBudgeted > 0 ? `${Math.round((totalSpent / totalBudgeted) * 100)}%` : '0%',
        daily_target: formatCurrency(overallDailyTarget),
        daily_actual: formatCurrency(overallDailyActual),
        daily_allowance_remaining: formatCurrency(dailyAllowanceRemaining),
        projected_end_of_month: formatCurrency(projectedTotalSpend),
      },
      category_status: statusCounts,
      categories_needing_attention: categoryPaces
        .filter((c) => c.status === 'overspent' || c.status === 'behind')
        .slice(0, 10)
        .map((c) => ({
          category: c.category_name,
          group: c.group_name,
          budgeted: formatCurrency(c.budgeted),
          spent: formatCurrency(c.spent),
          remaining: formatCurrency(c.remaining),
          daily_target: formatCurrency(c.daily_target),
          daily_actual: formatCurrency(c.daily_actual),
          status: c.status,
        })),
      categories_ahead: categoryPaces
        .filter((c) => c.status === 'ahead')
        .slice(0, 5)
        .map((c) => ({
          category: c.category_name,
          group: c.group_name,
          remaining: formatCurrency(c.remaining),
          status: c.status,
        })),
    },
    null,
    2
  );
}
