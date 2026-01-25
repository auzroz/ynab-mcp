/**
 * List Account Transactions Tool
 *
 * Returns transactions for a specific account.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { parseNaturalDate } from '../../utils/dates.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  account_id: z.string().describe('The account UUID to get transactions for'),
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
export const listAccountTransactionsTool: Tool = {
  name: 'ynab_list_account_transactions',
  description: `List transactions for a specific account.

Use when the user asks:
- "Show transactions for my checking account"
- "What purchases were made on my credit card?"
- "List activity in [account name]"

Requires an account_id. Use ynab_list_accounts first to find the account ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      account_id: {
        type: 'string',
        description: 'The account UUID to get transactions for',
      },
      since_date: {
        type: 'string',
        description:
          'Only return transactions on or after this date. Accepts YYYY-MM-DD or natural language like "past 30 days"',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of transactions to return (default 100, max 500)',
      },
    },
    required: ['account_id'],
  },
};

// Handler function
export async function handleListAccountTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 100;

  // Parse natural language dates
  const sinceDate = validated.since_date ? parseNaturalDate(validated.since_date) : undefined;

  const response = await client.getAccountTransactions(
    budgetId,
    validated.account_id,
    sinceDate
  );

  let transactions = response.data.transactions;

  // Sort by date descending
  transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Apply limit
  transactions = transactions.slice(0, limit);

  // Calculate summary
  const inflow = transactions.filter((t) => t.amount > 0);
  const outflow = transactions.filter((t) => t.amount < 0);
  const totalInflow = sumMilliunits(inflow.map((t) => t.amount));
  const totalOutflow = sumMilliunits(outflow.map((t) => Math.abs(t.amount)));

  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: txn.memo,
    payee_name: txn.payee_name,
    category_name: txn.category_name,
    cleared: txn.cleared,
    approved: txn.approved,
  }));

  return JSON.stringify(
    {
      account_id: validated.account_id,
      transactions: formattedTransactions,
      summary: {
        count: formattedTransactions.length,
        total_inflow: formatCurrency(totalInflow),
        total_outflow: formatCurrency(totalOutflow),
        net: formatCurrency(totalInflow - totalOutflow),
      },
    },
    null,
    2
  );
}
