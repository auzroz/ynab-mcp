/**
 * List Payee Transactions Tool
 *
 * Returns transactions for a specific payee.
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
  payee_id: z.string().uuid().describe('The payee UUID to get transactions for'),
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
export const listPayeeTransactionsTool: Tool = {
  name: 'ynab_list_payee_transactions',
  description: `List transactions for a specific payee (merchant/vendor).

Use when the user asks:
- "Show my Amazon purchases"
- "What have I spent at Costco?"
- "List transactions for [payee name]"

Requires a payee_id. Use ynab_list_payees first to find the payee ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      payee_id: {
        type: 'string',
        format: 'uuid',
        description: 'The payee UUID to get transactions for',
      },
      since_date: {
        type: 'string',
        description:
          'Only return transactions on or after this date. Accepts YYYY-MM-DD or natural language like "past 30 days"',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'Maximum number of transactions to return (default 100, max 500)',
      },
    },
    required: ['payee_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_list_payee_transactions tool.
 */
export async function handleListPayeeTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 100;

  // Parse natural language dates
  const sinceDate = validated.since_date ? parseNaturalDate(validated.since_date) : undefined;

  const response = await client.getPayeeTransactions(
    budgetId,
    validated.payee_id,
    sinceDate
  );

  // Sort by date descending and apply limit (avoid mutating response)
  const transactions = [...response.data.transactions]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);

  // Calculate summary - separate inflows and outflows for clarity
  const outflows = transactions.filter((t) => t.amount < 0);
  const inflowCount = transactions.filter((t) => t.amount >= 0).length;
  const totalSpent = sumMilliunits(outflows.map((t) => Math.abs(t.amount)));

  // Group by category (outflows only)
  const byCategory: Record<string, number> = {};
  for (const txn of outflows) {
    const category = txn.category_name ?? 'Uncategorized';
    byCategory[category] = (byCategory[category] ?? 0) + Math.abs(txn.amount);
  }

  // Top categories
  const topCategories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, amount]) => ({ name: sanitizeName(name), amount: formatCurrency(amount) }));

  // Calculate average and frequency (outflows only)
  const avgAmount = outflows.length > 0 ? totalSpent / outflows.length : 0;

  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: sanitizeMemo(txn.memo),
    category_name: sanitizeName(txn.category_name),
    account_name: sanitizeName(txn.account_name),
    cleared: txn.cleared,
  }));

  return JSON.stringify(
    {
      payee_id: validated.payee_id,
      transactions: formattedTransactions,
      summary: {
        count: formattedTransactions.length,
        outflow_count: outflows.length,
        inflow_count: inflowCount,
        total_spent: formatCurrency(totalSpent),
        average_outflow: formatCurrency(avgAmount), // Average per outflow transaction
        top_categories: topCategories,
      },
    },
    null,
    2
  );
}
