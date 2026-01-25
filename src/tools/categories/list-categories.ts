/**
 * List Categories Tool
 * 
 * Returns all category groups and categories in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  include_hidden: z
    .boolean()
    .optional()
    .describe('Whether to include hidden categories'),
});

// Tool definition
export const listCategoriesTool: Tool = {
  name: 'ynab_list_categories',
  description: `List all category groups and categories in a budget with budgeted amounts and balances.

Use when the user asks:
- "What categories do I have?"
- "Show my budget categories"
- "How is my budget organized?"
- "What are my spending categories?"
- "List my budget breakdown"

Returns category groups with their categories, including budgeted amounts, activity, and remaining balances.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      include_hidden: {
        type: 'boolean',
        description: 'Whether to include hidden categories',
      },
    },
  },
};

// Handler function
/**
 * Handler for the ynab_list_categories tool.
 */
export async function handleListCategories(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const includeHidden = validated.include_hidden ?? false;

  const response = await client.getCategories(budgetId);
  let groups = response.data.category_groups;

  // Filter out internal category group unless explicitly including hidden
  if (!includeHidden) {
    groups = groups.filter((g) => !g.hidden && g.name !== 'Internal Master Category');
  }

  // Build response with categories grouped
  const categoryGroups = groups.map((group) => {
    let categories = group.categories;
    
    if (!includeHidden) {
      categories = categories.filter((c) => !c.hidden);
    }

    return {
      id: group.id,
      name: sanitizeName(group.name),
      hidden: group.hidden,
      categories: categories.map((cat) => ({
        id: cat.id,
        name: sanitizeName(cat.name),
        budgeted: formatCurrency(cat.budgeted),
        activity: formatCurrency(cat.activity),
        balance: formatCurrency(cat.balance),
        balance_raw: cat.balance,
        goal_type: cat.goal_type ?? null,
        goal_percentage_complete: cat.goal_percentage_complete ?? null,
        goal_under_funded:
          cat.goal_under_funded != null ? formatCurrency(cat.goal_under_funded) : null,
        goal_under_funded_raw: cat.goal_under_funded ?? null,
        hidden: cat.hidden,
      })),
    };
  });

  // Calculate summary stats from the same filtered data used in detail
  // Use the filtered groups and apply the same category filter for consistency
  const allCategories = categoryGroups.flatMap((g) => g.categories);
  const filteredCategoriesRaw = groups
    .flatMap((g) => includeHidden ? g.categories : g.categories.filter((c) => !c.hidden));
  const totalBudgeted = filteredCategoriesRaw.reduce((sum, c) => sum + c.budgeted, 0);
  const totalActivity = filteredCategoriesRaw.reduce((sum, c) => sum + c.activity, 0);
  const totalBalance = filteredCategoriesRaw.reduce((sum, c) => sum + c.balance, 0);

  // Find categories with issues (using raw values for accurate filtering)
  const overspent = allCategories.filter((c) => c.balance_raw < 0);

  const underfunded = allCategories.filter((c) =>
    c.goal_under_funded_raw !== null && c.goal_under_funded_raw > 0
  );

  return JSON.stringify(
    {
      category_groups: categoryGroups,
      summary: {
        group_count: categoryGroups.length,
        category_count: allCategories.length,
        total_budgeted: formatCurrency(totalBudgeted),
        total_activity: formatCurrency(totalActivity),
        total_balance: formatCurrency(totalBalance),
        overspent_count: overspent.length,
        underfunded_count: underfunded.length,
      },
      alerts: {
        overspent_categories: overspent.map((c) => ({ name: c.name, balance: c.balance })),
        underfunded_goals: underfunded.map((c) => ({ 
          name: c.name, 
          under_funded: c.goal_under_funded 
        })),
      },
    },
    null,
    2
  );
}
