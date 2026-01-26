/**
 * List Category Transactions Tool
 *
 * Returns transactions for a specific category.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { parseNaturalDate } from '../../utils/dates.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  category_id: z.string().uuid().describe('The category UUID to get transactions for'),
  since_date: z
    .string()
    .optional()
    .describe(
      'Only return transactions on or after this date. Accepts ISO dates (YYYY-MM-DD) or natural language like "past 30 days", "this month"'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Maximum number of transactions to return (default 100, max 500)'),
});

// Tool definition
export const listCategoryTransactionsTool: Tool = {
  name: 'ynab_list_category_transactions',
  description: `List transactions for a specific category.

Use when the user asks:
- "Show my grocery transactions"
- "What did I spend on dining out?"
- "List transactions in [category name]"

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
        format: 'uuid',
        description: 'The category UUID to get transactions for',
      },
      since_date: {
        type: 'string',
        description:
          'Only return transactions on or after this date. Accepts YYYY-MM-DD or natural language like "past 30 days"',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of transactions to return (default 100, max 500)',
        minimum: 1,
        maximum: 500,
      },
    },
    required: ['category_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_list_category_transactions tool.
 */
export async function handleListCategoryTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 100;

  // Parse natural language dates
  const sinceDate = validated.since_date ? parseNaturalDate(validated.since_date) : undefined;

  const response = await client.getCategoryTransactions(
    budgetId,
    validated.category_id,
    sinceDate
  );

  // Sort by date descending and apply limit (avoid mutating response)
  const transactions = [...response.data.transactions]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);

  // Calculate summary - only count outflows (negative amounts) as spending
  const outflows = transactions.filter((t) => t.amount < 0);
  const totalSpent = sumMilliunits(outflows.map((t) => Math.abs(t.amount)));

  // Group by payee - only count outflows, sanitize during aggregation
  const byPayee: Record<string, number> = {};
  for (const txn of outflows) {
    const payee = sanitizeName(txn.payee_name) ?? 'Unknown';
    byPayee[payee] = (byPayee[payee] ?? 0) + Math.abs(txn.amount);
  }

  // Top payees (already sanitized during aggregation)
  const topPayees = Object.entries(byPayee)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, amount]) => ({ name, amount: formatCurrency(amount) }));

  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: sanitizeMemo(txn.memo),
    payee_name: sanitizeName(txn.payee_name),
    account_name: sanitizeName(txn.account_name),
    cleared: txn.cleared,
  }));

  return JSON.stringify(
    {
      category_id: validated.category_id,
      transactions: formattedTransactions,
      summary: {
        count: formattedTransactions.length,
        total_spent: formatCurrency(totalSpent),
        top_payees: topPayees,
      },
    },
    null,
    2
  );
}
