/**
 * Update Category Tool
 *
 * Updates the budgeted amount for a category in a specific month.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';
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
    .describe('The budget month in YYYY-MM-01 format (first of month, e.g., 2024-01-01)'),
  category_id: z.string().describe('The category UUID to update'),
  budgeted: z
    .number()
    .finite()
    .describe('The new budgeted amount in dollars (e.g., 500.00 for $500)'),
});

// Tool definition
export const updateCategoryTool: Tool = {
  name: 'ynab_update_category',
  description: `Update the budgeted amount for a category in a specific month.

Use when the user asks:
- "Budget $500 for Groceries this month"
- "Set my dining out budget to $200"
- "Increase my entertainment budget"
- "Change the budget for [category] to [amount]"

Use first-of-month format for the month parameter (e.g., 2024-01-01 for January 2024).
The budgeted amount is in dollars (e.g., 500.00 for $500).
Requires a category_id. Use ynab_list_categories first to find the category ID.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
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
        description: 'The category UUID to update',
      },
      budgeted: {
        type: 'number',
        description: 'The new budgeted amount in dollars',
      },
    },
    required: ['month', 'category_id', 'budgeted'],
  },
};

// Handler function
/**
 * Handler for the ynab_update_category tool.
 */
export async function handleUpdateCategory(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.updateMonthCategory(
    budgetId,
    validated.month,
    validated.category_id,
    {
      category: {
        budgeted: toMilliunits(validated.budgeted),
      },
    }
  );

  const category = response.data.category;

  const categoryName = sanitizeName(category.name);
  return JSON.stringify(
    {
      success: true,
      message: `Budget for "${categoryName}" updated to ${formatCurrency(category.budgeted)}`,
      month: validated.month,
      category: {
        id: category.id,
        name: categoryName,
        budgeted: formatCurrency(category.budgeted),
        activity: formatCurrency(category.activity),
        balance: formatCurrency(category.balance),
      },
    },
    null,
    2
  );
}
