/**
 * List Months Tool
 *
 * Returns all budget months.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const listMonthsTool: Tool = {
  name: 'ynab_list_months',
  description: `List all budget months with summary information.

Use when the user asks:
- "Show my budget months"
- "What months do I have budgeted?"
- "List my budget history"
- "Show me past months"

Returns each month's income, budgeted, activity, and to-be-budgeted amounts.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
  },
};

// Handler function
export async function handleListMonths(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getBudgetMonths(budgetId);
  const months = response.data.months;

  const formattedMonths = months.map((month) => ({
    month: month.month,
    note: month.note,
    income: formatCurrency(month.income),
    budgeted: formatCurrency(month.budgeted),
    activity: formatCurrency(month.activity),
    to_be_budgeted: formatCurrency(month.to_be_budgeted),
    age_of_money: month.age_of_money,
    deleted: month.deleted,
  }));

  return JSON.stringify(
    {
      months: formattedMonths,
      count: months.length,
    },
    null,
    2
  );
}
