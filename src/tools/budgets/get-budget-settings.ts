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
export async function handleGetBudgetSettings(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getBudgetSettingsById(budgetId);
  const settings = response.data.settings;

  return JSON.stringify(
    {
      budget_id: sanitizeString(budgetId) ?? '',
      settings: {
        date_format: sanitizeString(settings.date_format.format) ?? '',
        currency_format: {
          iso_code: sanitizeString(settings.currency_format.iso_code) ?? '',
          example_format: sanitizeString(settings.currency_format.example_format) ?? '',
          decimal_digits: settings.currency_format.decimal_digits,
          decimal_separator: sanitizeString(settings.currency_format.decimal_separator) ?? '',
          symbol_first: settings.currency_format.symbol_first,
          group_separator: sanitizeString(settings.currency_format.group_separator) ?? '',
          currency_symbol: sanitizeString(settings.currency_format.currency_symbol) ?? '',
          display_symbol: settings.currency_format.display_symbol,
        },
      },
    },
    null,
    2
  );
}
