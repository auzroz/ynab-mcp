/**
 * List Budgets Tool
 * 
 * Returns all budgets the user has access to.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, formatCurrencyWithFormat } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  include_accounts: z
    .boolean()
    .optional()
    .describe('Whether to include account summaries for each budget'),
});

// Tool definition
export const listBudgetsTool: Tool = {
  name: 'ynab_list_budgets',
  description: `List all budgets the user has access to in YNAB.

Use when the user asks:
- "What budgets do I have?"
- "Show me my YNAB budgets"
- "List my budgets"
- "Which budget should I use?"

Returns budget names, IDs, and last modified dates. Optionally includes account summaries.`,
  inputSchema: {
    type: 'object',
    properties: {
      include_accounts: {
        type: 'boolean',
        description: 'Whether to include account summaries for each budget',
      },
    },
  },
};

// Handler function
/**
 * Handler for the ynab_list_budgets tool.
 */
export async function handleListBudgets(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  
  const response = await client.getBudgets(validated.include_accounts ?? false);
  const budgets = response.data.budgets;

  const result = budgets.map((budget) => {
    // Sanitize currency_format fields if present
    const sanitizedCurrencyFormat = budget.currency_format
      ? {
          iso_code: sanitizeString(budget.currency_format.iso_code) ?? '',
          example_format: sanitizeString(budget.currency_format.example_format) ?? '',
          decimal_digits: budget.currency_format.decimal_digits,
          decimal_separator: sanitizeString(budget.currency_format.decimal_separator) ?? '',
          symbol_first: budget.currency_format.symbol_first,
          group_separator: sanitizeString(budget.currency_format.group_separator) ?? '',
          currency_symbol: sanitizeString(budget.currency_format.currency_symbol) ?? '',
          display_symbol: budget.currency_format.display_symbol,
        }
      : undefined;

    const budgetInfo: Record<string, unknown> = {
      id: budget.id,
      name: sanitizeName(budget.name),
      last_modified: budget.last_modified_on,
      currency_format: sanitizedCurrencyFormat,
    };

    if (budget.accounts != null && budget.accounts.length > 0) {
      // Use budget's currency format if available, otherwise fall back to default formatting
      const currencyFormat = budget.currency_format;
      budgetInfo['accounts'] = budget.accounts.map((acc) => ({
        name: sanitizeName(acc.name),
        type: acc.type,
        balance: currencyFormat
          ? formatCurrencyWithFormat(acc.balance, currencyFormat)
          : formatCurrency(acc.balance),
        closed: acc.closed,
      }));
    }

    return budgetInfo;
  });

  return JSON.stringify(
    {
      budgets: result,
      count: budgets.length,
      default_budget_id: client.getDefaultBudgetId(),
    },
    null,
    2
  );
}
