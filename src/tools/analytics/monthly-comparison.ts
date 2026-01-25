/**
 * Monthly Comparison Tool
 *
 * Compares this month vs previous month for key metrics.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { getCurrentMonth, getPreviousMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const monthlyComparisonTool: Tool = {
  name: 'ynab_monthly_comparison',
  description: `Compare this month vs last month for spending and budgeting.

Use when the user asks:
- "How does this month compare to last month?"
- "Am I spending more or less?"
- "Month over month comparison"
- "Compare my spending"
- "What's changed since last month?"

Returns side-by-side comparison of spending, income, and category performance.`,
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

interface CategoryChange {
  category: string;
  group: string;
  this_month: string;
  last_month: string;
  change: string;
  change_percent: number | null;
  direction: 'up' | 'down' | 'same' | 'new';
  rawChange: number;
}

// Handler function
/**
 * Handler for the ynab_monthly_comparison tool.
 */
export async function handleMonthlyComparison(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const currentMonth = getCurrentMonth();
  const previousMonth = getPreviousMonth();

  // Get both months' data and categories
  const [currentMonthResponse, previousMonthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, currentMonth),
    client.getBudgetMonth(budgetId, previousMonth),
    client.getCategories(budgetId),
  ]);

  const currentData = currentMonthResponse.data.month;
  const previousData = previousMonthResponse.data.month;

  // Build group lookup
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Calculate overall metrics for current month
  let currentIncome = 0;
  let currentSpending = 0;
  let currentBudgeted = 0;

  for (const cat of currentData.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    currentBudgeted += cat.budgeted;
    if (cat.activity < 0) {
      currentSpending += Math.abs(cat.activity);
    } else if (cat.activity > 0) {
      currentIncome += cat.activity;
    }
  }

  // Calculate overall metrics for previous month
  let previousIncome = 0;
  let previousSpending = 0;
  let previousBudgeted = 0;

  for (const cat of previousData.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    previousBudgeted += cat.budgeted;
    if (cat.activity < 0) {
      previousSpending += Math.abs(cat.activity);
    } else if (cat.activity > 0) {
      previousIncome += cat.activity;
    }
  }

  // Build category comparison map
  const categoryMap = new Map<
    string,
    { current: number; previous: number; name: string; group: string }
  >();

  for (const cat of currentData.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    categoryMap.set(cat.id, {
      current: cat.activity < 0 ? Math.abs(cat.activity) : 0,
      previous: 0,
      name: sanitizeName(cat.name),
      group: sanitizeName(groupName),
    });
  }

  for (const cat of previousData.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    const existing = categoryMap.get(cat.id);
    if (existing) {
      existing.previous = cat.activity < 0 ? Math.abs(cat.activity) : 0;
    } else {
      categoryMap.set(cat.id, {
        current: 0,
        previous: cat.activity < 0 ? Math.abs(cat.activity) : 0,
        name: sanitizeName(cat.name),
        group: sanitizeName(groupName),
      });
    }
  }

  // Build category changes list
  const categoryChanges: CategoryChange[] = [];

  for (const [, data] of categoryMap) {
    if (data.current === 0 && data.previous === 0) continue;

    const change = data.current - data.previous;

    // Threshold of $10 (10000 milliunits) to avoid noise from minor fluctuations
    const CHANGE_THRESHOLD = 10000;
    let direction: 'up' | 'down' | 'same' | 'new';
    let changePercent: number | null;

    // Handle "new" category (no spending last month, spending this month)
    if (data.previous === 0 && data.current > 0) {
      direction = 'new';
      changePercent = null;
    } else if (data.previous !== 0) {
      changePercent = Math.round((change / data.previous) * 100);
      if (change > CHANGE_THRESHOLD) {
        direction = 'up';
      } else if (change < -CHANGE_THRESHOLD) {
        direction = 'down';
      } else {
        direction = 'same';
      }
    } else {
      // This branch handles: previous === 0 && current === 0
      // Due to the continue on line 163, this is unreachable, but included for completeness
      direction = 'same';
      changePercent = null;
    }

    categoryChanges.push({
      category: data.name,
      group: data.group,
      this_month: formatCurrency(data.current),
      last_month: formatCurrency(data.previous),
      change: direction === 'new' ? 'new' : formatCurrency(change),
      change_percent: changePercent,
      direction,
      rawChange: change,
    });
  }

  // Sort by absolute change (biggest changes first, using raw numeric value)
  categoryChanges.sort((a, b) => Math.abs(b.rawChange) - Math.abs(a.rawChange));

  // Calculate changes
  const spendingChange = currentSpending - previousSpending;
  // Handle previousSpending = 0 case: if current > 0, treat as 100% increase
  const spendingChangePercent =
    previousSpending !== 0
      ? ((spendingChange / previousSpending) * 100)
      : currentSpending > 0 ? 100 : 0;

  const incomeChange = currentIncome - previousIncome;
  // Guard against division by zero for income change percent
  const incomeChangePercent =
    previousIncome !== 0
      ? ((incomeChange / previousIncome) * 100)
      : currentIncome > 0 ? 100 : 0;
  const budgetedChange = currentBudgeted - previousBudgeted;

  // Determine overall status
  let status: 'better' | 'worse' | 'similar';
  let message: string;

  // Special handling when previous month has no spending
  if (previousSpending === 0) {
    if (currentSpending === 0) {
      status = 'similar';
      message = 'No spending in either month';
    } else {
      status = 'worse';
      message = `Spending increased from $0 last month to ${formatCurrency(currentSpending)}`;
    }
  } else if (spendingChangePercent < -10) {
    status = 'better';
    message = `Spending is down ${Math.abs(Math.round(spendingChangePercent))}% from last month`;
  } else if (spendingChangePercent > 10) {
    status = 'worse';
    message = `Spending is up ${Math.round(spendingChangePercent)}% from last month`;
  } else {
    status = 'similar';
    message = 'Spending is similar to last month';
  }

  // Get biggest increases and decreases (include 'new' in increases)
  const biggestIncreases = categoryChanges
    .filter((c) => c.direction === 'up' || c.direction === 'new')
    .slice(0, 5);
  const biggestDecreases = categoryChanges
    .filter((c) => c.direction === 'down')
    .slice(0, 5);

  return JSON.stringify(
    {
      status,
      message,
      months: {
        current: currentMonth,
        previous: previousMonth,
      },
      comparison: {
        spending: {
          this_month: formatCurrency(currentSpending),
          last_month: formatCurrency(previousSpending),
          change: formatCurrency(spendingChange),
          change_percent: Math.round(spendingChangePercent),
          direction: spendingChange > 0 ? 'up' : spendingChange < 0 ? 'down' : 'same',
        },
        income: {
          this_month: formatCurrency(currentIncome),
          last_month: formatCurrency(previousIncome),
          change: formatCurrency(incomeChange),
          change_percent: Math.round(incomeChangePercent),
          direction: incomeChange > 0 ? 'up' : incomeChange < 0 ? 'down' : 'same',
        },
        budgeted: {
          this_month: formatCurrency(currentBudgeted),
          last_month: formatCurrency(previousBudgeted),
          change: formatCurrency(budgetedChange),
        },
      },
      notable_changes: {
        biggest_increases: biggestIncreases.map((c) => ({
          category: c.category,
          group: c.group,
          this_month: c.this_month,
          last_month: c.last_month,
          change: c.change,
          change_percent: c.direction === 'new' ? 'new' : `+${c.change_percent}%`,
        })),
        biggest_decreases: biggestDecreases.map((c) => ({
          category: c.category,
          group: c.group,
          this_month: c.this_month,
          last_month: c.last_month,
          change: c.change,
          change_percent: `${c.change_percent}%`,
        })),
      },
      insights: {
        categories_with_increased_spending: categoryChanges.filter((c) => c.direction === 'up')
          .length,
        categories_with_decreased_spending: categoryChanges.filter((c) => c.direction === 'down')
          .length,
        categories_unchanged: categoryChanges.filter((c) => c.direction === 'same').length,
        new_categories: categoryChanges.filter((c) => c.direction === 'new').length,
      },
    },
    null,
    2
  );
}
