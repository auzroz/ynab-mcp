/**
 * List Budgets Tool
 * 
 * Returns all budgets the user has access to.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { makeMoneyFormatter } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';
import { toOutputSchema } from '../output-schema.js';
import { count, currencyFormatSchema, dateFormatSchema, fromYnab, money } from '../schemas/common.js';
import { omitNull } from '../../utils/omit-null.js';

// Input schema
const inputSchema = z.object({
  include_accounts: z
    .boolean()
    .optional()
    .describe('Whether to include account summaries for each budget'),
});

const budgetSchema = z.object({
  id: fromYnab(z.string()),
  name: z.string(),
  last_modified: z.string().exactOptional().describe('Omitted when YNAB does not report it'),
  currency_format: currencyFormatSchema.exactOptional().describe('Omitted when the budget has none'),
  first_month: z.string().nullable(),
  last_month: z.string().nullable(),
  date_format: dateFormatSchema.nullable(),
  accounts: z
    .array(
      z.object({
        id: fromYnab(z.string()),
        name: z.string(),
        type: fromYnab(z.string().describe('YNAB account type')),
        balance: money(),
        closed: fromYnab(z.boolean()),
      })
    )
    .exactOptional()
    .describe('With include_accounts, for a budget that has accounts'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const listBudgetsOutputSchema = z.object({
  budgets: z.array(budgetSchema),
  count: count(),
  default_budget_id: z.string(),
});
export type ListBudgetsOutput = z.output<typeof listBudgetsOutputSchema>;

// Tool definition
export const listBudgetsTool: Tool = {
  name: 'ynab_list_budgets',
  description: `List all budgets the user has access to in YNAB.

Use when the user asks:
- "What budgets do I have?"
- "Show me my YNAB budgets"
- "List my budgets"
- "Which budget should I use?"

Returns budget names, IDs, last modified dates, first and last month, and date format. Optionally includes account summaries.

Not possible through the YNAB API (do it in the YNAB app): creating, renaming or deleting plans (budgets), and changing plan settings.`,
  inputSchema: {
    type: 'object',
    properties: {
      include_accounts: {
        type: 'boolean',
        description: 'Whether to include account summaries for each budget',
      },
    },
  },
  outputSchema: toOutputSchema(listBudgetsOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_list_budgets tool.
 */
export async function handleListBudgets(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<ListBudgetsOutput> {
  const validated = inputSchema.parse(args);
  
  const response = await client.getBudgets(validated.include_accounts ?? false);
  // ynab v4 renamed the API response's "budgets" collection to "plans".
  const budgets = response.data.plans;

  const result = budgets.map((budget): z.output<typeof budgetSchema> => {
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
      : null;

    const budgetInfo: z.output<typeof budgetSchema> = {
      id: budget.id,
      name: sanitizeName(budget.name),
      ...omitNull({ last_modified: budget.last_modified_on, currency_format: sanitizedCurrencyFormat }),
      first_month: budget.first_month ?? null,
      last_month: budget.last_month ?? null,
      date_format: budget.date_format
        ? { format: sanitizeString(budget.date_format.format) ?? '' }
        : null,
    };

    if (budget.accounts != null && budget.accounts.length > 0) {
      // Use budget's currency format if available, otherwise fall back to default formatting
      const money = makeMoneyFormatter(budget.currency_format);
      budgetInfo.accounts = budget.accounts.map((acc) => ({
        id: acc.id,
        name: sanitizeName(acc.name),
        type: acc.type,
        balance: money(acc.balance),
        closed: acc.closed,
      }));
    }

    return budgetInfo;
  });

  return {
    budgets: result,
    count: budgets.length,
    default_budget_id: client.getDefaultBudgetId(),
  };
}
