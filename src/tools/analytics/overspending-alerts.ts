/**
 * Overspending Alerts Tool
 *
 * Quick check for categories that are currently overspent.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Threshold for minor vs significant overspending (in milliunits, $50 = 50000)
const MINOR_OVERSPEND_THRESHOLD_MILLIS = 50000;

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  threshold: z
    .number()
    .optional()
    .describe('Minimum overspend amount to report in dollars (default 0)'),
});

// Tool definition
export const overspendingAlertsTool: Tool = {
  name: 'ynab_overspending_alerts',
  description: `Check for categories that are currently overspent.

Use when the user asks:
- "Am I overspending?"
- "What categories are over budget?"
- "Any overspending alerts?"
- "Where am I in the red?"
- "Check my budget status"

Returns a quick list of all overspent categories with amounts.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      threshold: {
        type: 'number',
        description: 'Minimum overspend amount to report in dollars (default 0)',
      },
    },
    required: [],
  },
};

interface OverspentCategory {
  category_name: string;
  group_name: string;
  budgeted: number;
  activity: number;
  overspent: number;
  percent_over: number;
}

// Handler function
/**
 * Handler for the ynab_overspending_alerts tool.
 */
export async function handleOverspendingAlerts(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const thresholdMilliunits = toMilliunits(validated.threshold ?? 0);

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

  // Find overspent categories
  const overspent: OverspentCategory[] = [];

  for (const cat of monthResponse.data.month.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    // Check for overspending using YNAB's available balance
    // A negative balance means the category is overspent
    if (cat.balance < 0 && Math.abs(cat.balance) >= thresholdMilliunits) {
      const overspentAmount = Math.abs(cat.balance);
      const budgeted = cat.budgeted;
      const spending = cat.activity < 0 ? Math.abs(cat.activity) : 0;
      const percentOver = budgeted > 0 ? (overspentAmount / budgeted) * 100 : 100;

      overspent.push({
        category_name: sanitizeName(cat.name),
        group_name: sanitizeName(groupName),
        budgeted: budgeted,
        activity: spending,
        overspent: overspentAmount,
        percent_over: percentOver,
      });
    }
  }

  // Sort by overspent amount (highest first)
  overspent.sort((a, b) => b.overspent - a.overspent);

  // Calculate totals
  const totalOverspent = overspent.reduce((sum, c) => sum + c.overspent, 0);
  const totalBudgeted = overspent.reduce((sum, c) => sum + c.budgeted, 0);
  const totalSpending = overspent.reduce((sum, c) => sum + c.activity, 0);

  // Determine status
  let status: 'all_clear' | 'minor_overspend' | 'significant_overspend';
  let message: string;

  if (overspent.length === 0) {
    status = 'all_clear';
    message = 'No overspending detected this month';
  } else if (totalOverspent < MINOR_OVERSPEND_THRESHOLD_MILLIS) {
    status = 'minor_overspend';
    message = `${overspent.length} category(ies) slightly over budget`;
  } else {
    status = 'significant_overspend';
    message = `${overspent.length} category(ies) over budget by ${formatCurrency(totalOverspent)} total`;
  }

  // Group by category group
  const byGroup = new Map<string, OverspentCategory[]>();
  for (const cat of overspent) {
    if (!byGroup.has(cat.group_name)) {
      byGroup.set(cat.group_name, []);
    }
    byGroup.get(cat.group_name)!.push(cat);
  }

  return JSON.stringify(
    {
      status,
      message,
      month: currentMonth,
      summary: {
        overspent_categories: overspent.length,
        total_overspent: formatCurrency(totalOverspent),
        total_budgeted_in_overspent: formatCurrency(totalBudgeted),
        total_spent_in_overspent: formatCurrency(totalSpending),
      },
      alerts: overspent.map((c) => ({
        category: c.category_name,
        group: c.group_name,
        budgeted: formatCurrency(c.budgeted),
        spent: formatCurrency(c.activity),
        over_by: formatCurrency(c.overspent),
        percent_over: `${Math.round(c.percent_over)}%`,
      })),
      by_group: Array.from(byGroup.entries()).map(([group, cats]) => ({
        group,
        count: cats.length,
        total_over: formatCurrency(cats.reduce((sum, c) => sum + c.overspent, 0)),
        categories: cats.map((c) => c.category_name),
      })),
      suggestions:
        overspent.length > 0
          ? [
              'Move funds from other categories to cover overspending',
              'Check if overspending can be offset by underspending elsewhere',
              'Consider adjusting future budgets based on actual needs',
            ]
          : [],
    },
    null,
    2
  );
}
