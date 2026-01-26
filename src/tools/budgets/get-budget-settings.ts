/**
 * Get Budget Settings Tool
 *
 * Returns budget settings including currency format and date format.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeString } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const getBudgetSettingsTool: Tool = {
  name: 'ynab_get_budget_settings',
  description: `Get settings for a budget including currency format, date format, and other preferences.

Use when the user asks:
- "What currency is my budget in?"
- "Show my budget settings"
- "What's my budget date format?"
- "What are my YNAB preferences?"

Returns currency format, date format, and currency ISO code.`,
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
/**
 * Handler for the ynab_get_budget_settings tool.
 */
export async function handleGetBudgetSettings(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getBudgetSettingsById(budgetId);
  const settings = response.data.settings;

  const dateFormat = settings.date_format;
  const currencyFormat = settings.currency_format;

  return JSON.stringify(
    {
      budget_id: sanitizeString(budgetId) ?? '',
      settings: {
        date_format: dateFormat ? sanitizeString(dateFormat.format) ?? '' : '',
        currency_format: currencyFormat
          ? {
              iso_code: sanitizeString(currencyFormat.iso_code) ?? '',
              example_format: sanitizeString(currencyFormat.example_format) ?? '',
              decimal_digits: currencyFormat.decimal_digits,
              decimal_separator: sanitizeString(currencyFormat.decimal_separator) ?? '',
              symbol_first: currencyFormat.symbol_first,
              group_separator: sanitizeString(currencyFormat.group_separator) ?? '',
              currency_symbol: sanitizeString(currencyFormat.currency_symbol) ?? '',
              display_symbol: currencyFormat.display_symbol,
            }
          : null,
      },
    },
    null,
    2
  );
}
