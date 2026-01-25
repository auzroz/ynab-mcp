/**
 * Get Month Tool
 *
 * Returns detailed information about a specific budget month.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema - accepts YYYY-MM-DD format or "current"
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: z
    .string()
    .refine(
      (val) => val === 'current' || /^\d{4}-\d{2}-\d{2}$/.test(val),
      { message: 'Month must be in YYYY-MM-DD format or "current"' }
    )
    .describe('The budget month in YYYY-MM-DD format (use first of month) or "current"'),
});

// Tool definition
export const getMonthTool: Tool = {
  name: 'ynab_get_month',
  description: `Get detailed information about a specific budget month including all categories.

Use when the user asks:
- "Show me January's budget"
- "What did I budget last month?"
- "Give me details for [month]"
- "How much did I have to budget in [month]?"

Use first-of-month format for the month parameter (e.g., 2024-01-01 for January 2024).
Use "current" for the current month.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      month: {
        type: 'string',
        description:
          'The budget month in YYYY-MM-DD format (use first of month, or "current")',
      },
    },
    required: ['month'],
  },
};

// Handler function
/**
 * Handler for the ynab_get_month tool.
 */
export async function handleGetMonth(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Convert "current" to actual month date
  const monthParam = validated.month === 'current' ? getCurrentMonth() : validated.month;

  // Fetch month data and categories in parallel
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, monthParam),
    client.getCategories(budgetId),
  ]);

  const month = monthResponse.data.month;

  // Build category group ID to name lookup
  const groupNameLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    groupNameLookup.set(group.id, group.name);
  }

  // Group categories by category group name (not ID)
  const categoriesByGroup: Record<
    string,
    Array<{
      name: string;
      budgeted: string;
      activity: string;
      balance: string;
    }>
  > = {};

  for (const category of month.categories) {
    if (category.hidden) continue;

    const groupName = sanitizeName(groupNameLookup.get(category.category_group_id) ?? 'Other');
    if (categoriesByGroup[groupName] === undefined) {
      categoriesByGroup[groupName] = [];
    }
    categoriesByGroup[groupName].push({
      name: sanitizeName(category.name),
      budgeted: formatCurrency(category.budgeted),
      activity: formatCurrency(category.activity),
      balance: formatCurrency(category.balance),
    });
  }

  return JSON.stringify(
    {
      month: month.month,
      summary: {
        note: sanitizeMemo(month.note),
        income: formatCurrency(month.income),
        budgeted: formatCurrency(month.budgeted),
        activity: formatCurrency(month.activity),
        to_be_budgeted: formatCurrency(month.to_be_budgeted),
        age_of_money: month.age_of_money,
      },
      category_count: month.categories.filter((c) => !c.hidden).length,
      categories_by_group: categoriesByGroup,
    },
    null,
    2
  );
}
