/**
 * List Months Tool
 *
 * Returns all budget months.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, formatCurrencyWithFormat } from '../../utils/milliunits.js';
import { sanitizeMemo } from '../../utils/sanitize.js';
import type { CurrencyFormat } from 'ynab';

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

/**
 * Format currency using the budget's currency format if available.
 */
function formatAmount(milliunits: number, currencyFormat?: CurrencyFormat | null): string {
  if (currencyFormat) {
    return formatCurrencyWithFormat(milliunits, currencyFormat);
  }
  return formatCurrency(milliunits);
}

// Handler function
export async function handleListMonths(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Fetch budget settings to get currency format
  const settingsResponse = await client.getBudgetSettingsById(budgetId);
  const currencyFormat = settingsResponse.data.settings.currency_format;

  const response = await client.getBudgetMonths(budgetId);
  const months = response.data.months;

  const formattedMonths = months.map((month) => ({
    month: month.month,
    note: sanitizeMemo(month.note),
    income: formatAmount(month.income, currencyFormat),
    budgeted: formatAmount(month.budgeted, currencyFormat),
    activity: formatAmount(month.activity, currencyFormat),
    to_be_budgeted: formatAmount(month.to_be_budgeted, currencyFormat),
    age_of_money: month.age_of_money,
    deleted: month.deleted,
  }));

  return JSON.stringify(
    {
      months: formattedMonths,
      count: months.length,
      currency_format: currencyFormat,
    },
    null,
    2
  );
}
