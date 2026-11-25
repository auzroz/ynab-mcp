/**
 * Budget vs Actuals Report Tool
 *
 * Compares budgeted amounts against actual spending for each category.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { indexCategoryGroups } from '../../utils/categories.js';
import { toOutputSchema } from '../output-schema.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, 'Month must be first-of-month format (YYYY-MM-01) with valid month (01-12)')
    .optional()
    .describe('Month to analyze in YYYY-MM-01 format (first of month). Defaults to current month'),
  include_previous: z
    .boolean()
    .optional()
    .describe('Include previous month for comparison (default false)'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). Amounts are formatted strings, *_raw milliunits. */
export const budgetVsActualsOutputSchema = z.object({
  month: z.string(),
  summary: z.object({
    total_budgeted: z.string(),
    total_activity: z.string(),
    budget_usage_percent: z.number().int().describe('0 when nothing is budgeted'),
    overspent_categories: z.number().int(),
    warning_categories: z.number().int(),
    on_track_categories: z.number().int(),
    underspent_categories: z.number().int(),
  }),
  alerts: z.object({
    overspent: z
      .array(z.object({ category: z.string(), group: z.string(), overspent_by: z.string() }))
      .describe('At most 5'),
    warnings: z
      .array(
        z.object({
          category: z.string(),
          group: z.string(),
          remaining: z.string(),
          percent_used: z.number().int().nullable().describe('Null only for a category with nothing budgeted'),
        })
      )
      .describe('At most 5'),
  }),
  by_group: z.array(
    z.object({
      group_name: z.string(),
      total_budgeted: z.string(),
      total_activity: z.string(),
      total_available: z.string(),
      categories: z.array(
        z.object({
          category_name: z.string(),
          group_name: z.string(),
          budgeted: z.string(),
          activity: z.string(),
          available: z.string(),
          budgeted_raw: z.number().int(),
          activity_raw: z.number().int(),
          available_raw: z.number().int(),
          variance: z.string(),
          variance_percent: z.number().int().nullable().describe('Null when nothing is budgeted'),
          status: z.enum(['on_track', 'warning', 'overspent', 'underspent']),
        })
      ),
    })
  ),
  previous_month_comparison: z
    .object({
      month: z.string(),
      total_budgeted: z.string(),
      total_activity: z.string(),
      activity_change: z.string(),
      activity_change_percent: z.number().int().describe('0 when the previous month had no spending'),
    })
    .nullable()
    .describe('Null unless include_previous is true'),
});
export type BudgetVsActualsOutput = z.output<typeof budgetVsActualsOutputSchema>;

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
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      month: {
        type: 'string',
        maxLength: 10,
        pattern: '^\\d{4}-(0[1-9]|1[0-2])-01$',
        description: 'Month to analyze in YYYY-MM-01 format (first of month, 01-12). Defaults to current month',
      },
      include_previous: {
        type: 'boolean',
        description: 'Include previous month for comparison',
      },
    },
    required: [],
  },
  outputSchema: toOutputSchema(budgetVsActualsOutputSchema),
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
): Promise<BudgetVsActualsOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);
  const month = validated.month ?? getCurrentMonth();

  // Get month data and categories in parallel
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, month),
    client.getCategories(budgetId),
  ]);

  const monthData = monthResponse.data.month;

  // Build category group lookup
  const { names: groupLookup, internalIds } = indexCategoryGroups(categoriesResponse.data.category_groups);

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
    if (category.hidden || internalIds.has(category.id)) {
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
      budgeted: money(budgeted),
      activity: money(activity),
      available: money(available),
      budgeted_raw: budgeted,
      activity_raw: activity,
      available_raw: available,
      variance: money(variance),
      variance_percent: variancePercent !== null ? Math.round(variancePercent) : null,
      status,
    };

    allCategories.push(categoryReport);

    // Add to group
    if (!groupReports.has(groupName)) {
      groupReports.set(groupName, {
        group_name: sanitizeName(groupName),
        total_budgeted: money(0),
        total_activity: money(0),
        total_available: money(0),
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

    group.total_budgeted = money(groupBudgeted);
    group.total_activity = money(groupActivity);
    group.total_available = money(groupAvailable);

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
      if (category.hidden || internalIds.has(category.id)) {
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
      total_budgeted: money(prevTotalBudgeted),
      total_activity: money(prevTotalActivity),
      activity_change: money(activityChange),
      activity_change_percent: Math.round(activityChangePercent),
    };
  }

  // Calculate overall budget health
  const budgetUsagePercent = totalBudgeted !== 0
    ? Math.round((totalActivity / totalBudgeted) * 100)
    : 0;

  return {
    month,
    summary: {
      total_budgeted: money(totalBudgeted),
      total_activity: money(totalActivity),
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
        overspent_by: money(Math.abs(c.available_raw)),
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
  };
}
