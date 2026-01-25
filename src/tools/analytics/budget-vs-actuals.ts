/**
 * Budget vs Actuals Report Tool
 *
 * Compares budgeted amounts against actual spending for each category.
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
  month: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/, 'Month must be first-of-month format (YYYY-MM-01)')
    .optional()
    .describe('Month to analyze in YYYY-MM-01 format (first of month). Defaults to current month'),
  include_previous: z
    .boolean()
    .optional()
    .describe('Include previous month for comparison (default false)'),
});

// Tool definition
export const budgetVsActualsTool: Tool = {
  name: 'ynab_budget_vs_actuals',
  description: `Compare budgeted amounts against actual spending for each category.

Use when the user asks:
- "How am I doing on my budget?"
- "Am I over budget anywhere?"
- "Compare budget vs actual"
- "Which categories are overspent?"
- "Show my budget performance"

Returns detailed budget vs actuals for all categories with variance analysis.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      month: {
        type: 'string',
        description: 'Month to analyze in YYYY-MM-01 format (first of month). Defaults to current month',
      },
      include_previous: {
        type: 'boolean',
        description: 'Include previous month for comparison',
      },
    },
    required: [],
  },
};

interface CategoryReport {
  category_name: string;
  group_name: string;
  budgeted: string;
  activity: string;
  available: string;
  budgeted_raw: number;
  activity_raw: number;
  available_raw: number;
  variance: string;
  variance_percent: number | null;
  status: 'on_track' | 'warning' | 'overspent' | 'underspent';
}

interface GroupReport {
  group_name: string;
  total_budgeted: string;
  total_activity: string;
  total_available: string;
  categories: CategoryReport[];
}

// Handler function
/**
 * Handler for the ynab_budget_vs_actuals tool.
 */
export async function handleBudgetVsActuals(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const month = validated.month ?? getCurrentMonth();

  // Get month data and categories in parallel
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, month),
    client.getCategories(budgetId),
  ]);

  const monthData = monthResponse.data.month;

  // Build category group lookup
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Build reports by category group
  const groupReports = new Map<string, GroupReport>();
  const allCategories: CategoryReport[] = [];

  // Stats tracking
  let totalBudgeted = 0;
  let totalActivity = 0;
  let overspentCount = 0;
  let underspentCount = 0;
  let onTrackCount = 0;
  let warningCount = 0;

  for (const category of monthData.categories) {
    const groupName = groupLookup.get(category.id) ?? 'Other';

    // Skip hidden categories and internal master category
    if (category.hidden || groupName === 'Internal Master Category') {
      continue;
    }

    const budgeted = category.budgeted;
    // Only count negative activity (actual spending), ignore refunds
    const activity = category.activity < 0 ? Math.abs(category.activity) : 0;
    const available = category.balance;

    totalBudgeted += budgeted;
    totalActivity += activity;

    // Calculate variance
    const variance = budgeted - activity;
    const variancePercent = budgeted !== 0 ? ((variance / budgeted) * 100) : null;

    // Determine status
    let status: CategoryReport['status'];
    if (available < 0) {
      status = 'overspent';
      overspentCount++;
    } else if (activity === 0 && budgeted > 0) {
      status = 'underspent';
      underspentCount++;
    } else if (variancePercent !== null && variancePercent > 50) {
      status = 'underspent';
      underspentCount++;
    } else if (variancePercent !== null && variancePercent < -10) {
      status = 'warning';
      warningCount++;
    } else {
      status = 'on_track';
      onTrackCount++;
    }

    const categoryReport: CategoryReport = {
      category_name: sanitizeName(category.name),
      group_name: sanitizeName(groupName),
      budgeted: formatCurrency(budgeted),
      activity: formatCurrency(activity),
      available: formatCurrency(available),
      budgeted_raw: budgeted,
      activity_raw: activity,
      available_raw: available,
      variance: formatCurrency(variance),
      variance_percent: variancePercent !== null ? Math.round(variancePercent) : null,
      status,
    };

    allCategories.push(categoryReport);

    // Add to group
    if (!groupReports.has(groupName)) {
      groupReports.set(groupName, {
        group_name: sanitizeName(groupName),
        total_budgeted: formatCurrency(0),
        total_activity: formatCurrency(0),
        total_available: formatCurrency(0),
        categories: [],
      });
    }

    groupReports.get(groupName)!.categories.push(categoryReport);
  }

  // Calculate group totals
  for (const [, group] of groupReports) {
    const groupBudgeted = group.categories.reduce((sum, c) => sum + c.budgeted_raw, 0);
    const groupActivity = group.categories.reduce((sum, c) => sum + c.activity_raw, 0);
    const groupAvailable = group.categories.reduce((sum, c) => sum + c.available_raw, 0);

    group.total_budgeted = formatCurrency(groupBudgeted);
    group.total_activity = formatCurrency(groupActivity);
    group.total_available = formatCurrency(groupAvailable);

    // Sort categories by activity (highest spending first)
    group.categories.sort((a, b) => b.activity_raw - a.activity_raw);
  }

  // Get overspent categories
  const overspentCategories = allCategories
    .filter((c) => c.status === 'overspent')
    .sort((a, b) => a.available_raw - b.available_raw);

  // Get warning categories
  const warningCategories = allCategories
    .filter((c) => c.status === 'warning')
    .sort((a, b) => a.available_raw - b.available_raw);

  // Optionally get previous month for comparison
  let previousMonthComparison: {
    month: string;
    total_budgeted: string;
    total_activity: string;
    activity_change: string;
    activity_change_percent: number;
  } | null = null;

  if (validated.include_previous) {
    // Calculate previous month relative to the input month, not today
    const [yearStr, monthStr] = month.split('-');
    const inputYear = parseInt(yearStr ?? '2024', 10);
    const inputMonth = parseInt(monthStr ?? '1', 10);
    const prevYear = inputMonth === 1 ? inputYear - 1 : inputYear;
    const prevMonthNum = inputMonth === 1 ? 12 : inputMonth - 1;
    const prevMonth = `${prevYear}-${String(prevMonthNum).padStart(2, '0')}-01`;
    const prevResponse = await client.getBudgetMonth(budgetId, prevMonth);
    const prevData = prevResponse.data.month;

    let prevTotalBudgeted = 0;
    let prevTotalActivity = 0;

    for (const category of prevData.categories) {
      const prevGroupName = groupLookup.get(category.id) ?? 'Other';
      if (category.hidden || prevGroupName === 'Internal Master Category') {
        continue;
      }
      prevTotalBudgeted += category.budgeted;
      if (category.activity < 0) {
        prevTotalActivity += Math.abs(category.activity);
      }
    }

    const activityChange = totalActivity - prevTotalActivity;
    const activityChangePercent = prevTotalActivity !== 0
      ? ((activityChange / prevTotalActivity) * 100)
      : 0;

    previousMonthComparison = {
      month: prevMonth,
      total_budgeted: formatCurrency(prevTotalBudgeted),
      total_activity: formatCurrency(prevTotalActivity),
      activity_change: formatCurrency(activityChange),
      activity_change_percent: Math.round(activityChangePercent),
    };
  }

  // Calculate overall budget health
  const budgetUsagePercent = totalBudgeted !== 0
    ? Math.round((totalActivity / totalBudgeted) * 100)
    : 0;

  return JSON.stringify(
    {
      month,
      summary: {
        total_budgeted: formatCurrency(totalBudgeted),
        total_activity: formatCurrency(totalActivity),
        budget_usage_percent: budgetUsagePercent,
        overspent_categories: overspentCount,
        warning_categories: warningCount,
        on_track_categories: onTrackCount,
        underspent_categories: underspentCount,
      },
      alerts: {
        overspent: overspentCategories.slice(0, 5).map((c) => ({
          category: c.category_name,
          group: c.group_name,
          overspent_by: formatCurrency(Math.abs(c.available_raw)),
        })),
        warnings: warningCategories.slice(0, 5).map((c) => ({
          category: c.category_name,
          group: c.group_name,
          remaining: c.available,
          percent_used: c.variance_percent !== null ? 100 - c.variance_percent : null,
        })),
      },
      by_group: Array.from(groupReports.values()).sort((a, b) =>
        a.group_name.localeCompare(b.group_name)
      ),
      previous_month_comparison: previousMonthComparison,
    },
    null,
    2
  );
}
