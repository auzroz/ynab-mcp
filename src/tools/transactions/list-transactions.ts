/**
 * List Transactions Tool
 *
 * Returns transactions for a budget with optional filters.
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
  since_date: z
    .string()
    .optional()
    .describe(
      'Only return transactions on or after this date. Accepts ISO dates (YYYY-MM-DD) or natural language: "today", "yesterday", "this week", "last week", "this month", "last month", "past 7 days", "past 30 days"'
    ),
  type: z
    .enum(['uncategorized', 'unapproved'])
    .optional()
    .describe('Filter by transaction type: "uncategorized" or "unapproved"'),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Maximum number of transactions to return (default 100, max 500)'),
});

// Tool definition
export const listTransactionsTool: Tool = {
  name: 'ynab_list_transactions',
  description: `List transactions for a budget with optional filters.

Use when the user asks:
- "Show my recent transactions"
- "What did I spend this month?"
- "List my uncategorized transactions"
- "Show transactions since [date]"
- "What purchases have I made recently?"
- "Show me the past 7 days of transactions"
- "What did I spend last week?"

Supports filtering by date (ISO or natural language like "past 30 days", "this month") and type (uncategorized/unapproved).
Returns transaction details including date, payee, amount, category, and status.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      since_date: {
        type: 'string',
        description:
          'Only return transactions on or after this date. Accepts YYYY-MM-DD or natural language: "today", "this week", "past 30 days", etc.',
      },
      type: {
        type: 'string',
        enum: ['uncategorized', 'unapproved'],
        description: 'Filter by transaction type',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of transactions to return (default 100, max 500)',
      },
    },
  },
};

// Handler function
export async function handleListTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 100;

  const options: {
    sinceDate?: string;
    type?: 'uncategorized' | 'unapproved';
  } = {};
  if (validated.since_date !== undefined) {
    // Parse natural language dates like "past 7 days", "this month", etc.
    options.sinceDate = parseNaturalDate(validated.since_date);
  }
  if (validated.type !== undefined) {
    options.type = validated.type;
  }

  const response = await client.getTransactions(budgetId, options);

  let transactions = response.data.transactions;

  // Sort by date descending (most recent first)
  transactions.sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateB - dateA;
  });

  // Apply limit
  transactions = transactions.slice(0, limit);

  // Calculate summary stats
  const inflow = transactions.filter((t) => t.amount > 0);
  const outflow = transactions.filter((t) => t.amount < 0);
  const totalInflow = sumMilliunits(inflow.map((t) => t.amount));
  const totalOutflow = sumMilliunits(outflow.map((t) => Math.abs(t.amount)));

  // Format transactions
  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: txn.memo,
    payee_name: txn.payee_name,
    category_name: txn.category_name,
    account_name: txn.account_name,
    cleared: txn.cleared,
    approved: txn.approved,
    flag_color: txn.flag_color,
    transfer_account_id: txn.transfer_account_id,
    subtransactions:
      txn.subtransactions.length > 0
        ? txn.subtransactions.map((sub) => ({
            amount: formatCurrency(sub.amount),
            memo: sub.memo,
            payee_name: sub.payee_name,
            category_name: sub.category_name,
          }))
        : undefined,
  }));

  // Date range
  const dates = transactions.map((t) => t.date);
  const minDate = dates.length > 0 ? dates[dates.length - 1] : null;
  const maxDate = dates.length > 0 ? dates[0] : null;

  return JSON.stringify(
    {
      transactions: formattedTransactions,
      summary: {
        count: formattedTransactions.length,
        total_inflow: formatCurrency(totalInflow),
        total_outflow: formatCurrency(totalOutflow),
        net: formatCurrency(totalInflow - totalOutflow),
        date_range: minDate && maxDate ? { from: minDate, to: maxDate } : null,
      },
      filters_applied: {
        since_date: validated.since_date
          ? { input: validated.since_date, parsed: options.sinceDate }
          : null,
        type: validated.type ?? null,
        limit,
      },
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
