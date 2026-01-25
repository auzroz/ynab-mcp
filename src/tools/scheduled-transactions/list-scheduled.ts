/**
 * List Scheduled Transactions Tool
 *
 * Returns all scheduled transactions in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const listScheduledTransactionsTool: Tool = {
  name: 'ynab_list_scheduled_transactions',
  description: `List all scheduled transactions (recurring bills, subscriptions, etc.) in a budget.

Use when the user asks:
- "Show my scheduled transactions"
- "What recurring bills do I have?"
- "List my subscriptions"
- "What payments are coming up?"

Returns scheduled transaction details including frequency, next occurrence, and amounts.`,
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
export async function handleListScheduledTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getScheduledTransactions(budgetId);
  const transactions = response.data.scheduled_transactions;

  // Filter out deleted and sort by next date
  const activeTransactions = transactions
    .filter((t) => !t.deleted)
    .sort((a, b) => a.date_next.localeCompare(b.date_next));

  const formattedTransactions = activeTransactions.map((txn) => ({
    id: txn.id,
    date_first: txn.date_first,
    date_next: txn.date_next,
    frequency: txn.frequency,
    amount: formatCurrency(txn.amount),
    memo: sanitizeMemo(txn.memo),
    payee_name: sanitizeName(txn.payee_name),
    category_name: sanitizeName(txn.category_name),
    account_name: sanitizeName(txn.account_name),
    flag_color: txn.flag_color,
    subtransactions:
      txn.subtransactions.length > 0
        ? txn.subtransactions.map((sub) => ({
            amount: formatCurrency(sub.amount),
            memo: sanitizeMemo(sub.memo),
            payee_id: sub.payee_id,
            category_id: sub.category_id,
          }))
        : undefined,
  }));

  // Calculate monthly total (approximate)
  const monthlyAmounts = activeTransactions.map((t) => {
    const amount = Math.abs(t.amount);
    const freq = String(t.frequency);
    switch (freq) {
      case 'daily':
        return amount * 30;
      case 'weekly':
        return amount * 4;
      case 'everyOtherWeek':
        return amount * 2;
      case 'twiceAMonth':
        return amount * 2;
      case 'every4Weeks':
        return amount;
      case 'monthly':
        return amount;
      case 'everyOtherMonth':
        return amount / 2;
      case 'every3Months':
        return amount / 3;
      case 'every4Months':
        return amount / 4;
      case 'twiceAYear':
        return amount / 6;
      case 'yearly':
        return amount / 12;
      case 'everyOtherYear':
        return amount / 24;
      default:
        return amount;
    }
  });

  const estimatedMonthlyTotal = sumMilliunits(monthlyAmounts);

  // Group by frequency
  const byFrequency: Record<string, number> = {};
  for (const txn of activeTransactions) {
    const freq = txn.frequency;
    byFrequency[freq] = (byFrequency[freq] ?? 0) + 1;
  }

  return JSON.stringify(
    {
      scheduled_transactions: formattedTransactions,
      summary: {
        total_count: formattedTransactions.length,
        estimated_monthly_total: formatCurrency(estimatedMonthlyTotal),
        by_frequency: byFrequency,
      },
    },
    null,
    2
  );
}
