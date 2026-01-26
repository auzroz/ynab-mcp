/**
 * Get Category Tool
 *
 * Returns details about a specific category.
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
  category_id: z.string().uuid().describe('The category UUID to retrieve'),
});

// Tool definition
export const getCategoryTool: Tool = {
  name: 'ynab_get_category',
  description: `Get details about a specific budget category including budgeted amount, activity, and goal status.

Use when the user asks:
- "Show me details for my Groceries category"
- "What's the balance in [category name]?"
- "How much is budgeted for [category]?"
- "What's my goal progress for [category]?"

Requires a category_id. Use ynab_list_categories first to find the category ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      category_id: {
        type: 'string',
        description: 'The category UUID to retrieve',
      },
    },
    required: ['category_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_get_category tool.
 */
export async function handleGetCategory(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getCategoryById(budgetId, validated.category_id);
  const category = response.data.category;

  return JSON.stringify(
    {
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
        original_category_group_id: category.original_category_group_id,
        deleted: category.deleted,
      },
    },
    null,
    2
  );
}
