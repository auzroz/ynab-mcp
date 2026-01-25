/**
 * Get Month Category Tool
 *
 * Returns category details for a specific month.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/, 'Month must be first-of-month format (YYYY-MM-01)')
    .describe('The budget month in YYYY-MM-01 format (first of month, e.g., 2024-01-01)'),
  category_id: z.string().uuid().describe('The category UUID to retrieve'),
});

// Tool definition
export const getMonthCategoryTool: Tool = {
  name: 'ynab_get_month_category',
  description: `Get category details for a specific month, including that month's budgeted amount, activity, and balance.

Use when the user asks:
- "How much did I budget for Groceries in January?"
- "What was my spending in [category] last month?"
- "Show me [category] for [month]"
- "What was my [category] balance in [month]?"

Use first-of-month format for the month parameter (e.g., 2024-01-01 for January 2024).
Requires a category_id. Use ynab_list_categories first to find the category ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      month: {
        type: 'string',
        description: 'The budget month in YYYY-MM-01 format (first of month)',
      },
      category_id: {
        type: 'string',
        description: 'The category UUID to retrieve',
      },
    },
    required: ['month', 'category_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_get_month_category tool.
 */
export async function handleGetMonthCategory(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getMonthCategoryById(
    budgetId,
    validated.month,
    validated.category_id
  );
  const category = response.data.category;

  return JSON.stringify(
    {
      month: validated.month,
      category: {
        id: category.id,
        category_group_id: category.category_group_id,
        name: sanitizeName(category.name),
        hidden: category.hidden,
        note: sanitizeMemo(category.note),
        budgeted: formatCurrency(category.budgeted),
        activity: formatCurrency(category.activity),
        balance: formatCurrency(category.balance),
        goal: category.goal_type
          ? {
              type: category.goal_type,
              target_month: category.goal_target_month,
              target: category.goal_target != null ? formatCurrency(category.goal_target) : null,
              percentage_complete: category.goal_percentage_complete,
              months_to_budget: category.goal_months_to_budget,
              under_funded:
                category.goal_under_funded != null
                  ? formatCurrency(category.goal_under_funded)
                  : null,
              overall_funded:
                category.goal_overall_funded != null
                  ? formatCurrency(category.goal_overall_funded)
                  : null,
              overall_left:
                category.goal_overall_left != null
                  ? formatCurrency(category.goal_overall_left)
                  : null,
            }
          : null,
      },
    },
    null,
    2
  );
}
