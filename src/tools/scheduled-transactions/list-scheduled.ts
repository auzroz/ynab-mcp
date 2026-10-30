/**
 * List Scheduled Transactions Tool
 *
 * Returns all scheduled transactions in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeFlagName } from '../transactions/format.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, deltaFields, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  since_server_knowledge: sinceServerKnowledge(),
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

Returns scheduled transaction details including frequency, next occurrence, and amounts.
Pass since_server_knowledge (the server_knowledge of an earlier response) to get only the scheduled transactions changed since then.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      since_server_knowledge: sinceServerKnowledgeJsonSchema,
    },
  },
};

// Handler function
/**
 * Handler for the ynab_list_scheduled_transactions tool.
 */
export async function handleListScheduledTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const cursor = validated.since_server_knowledge;
  const response =
    cursor === undefined
      ? await client.getScheduledTransactions(budgetId)
      : await client.getScheduledTransactions(budgetId, { lastKnowledgeOfServer: cursor });
  const { changed, deletedIds } = splitDeleted(response.data.scheduled_transactions, (t) => t.id);

  // Filter out deleted and sort by next date
  const activeTransactions = changed.sort((a, b) => a.date_next.localeCompare(b.date_next));

  const formattedTransactions = activeTransactions.map((txn) => {
    // A delta may list removed split lines as deleted.
    const subs = (txn.subtransactions ?? []).filter((sub) => !sub.deleted);
    return {
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
      flag_name: sanitizeFlagName(txn.flag_name),
      account_id: txn.account_id,
      payee_id: txn.payee_id ?? null,
      category_id: txn.category_id ?? null,
      transfer_account_id: txn.transfer_account_id ?? null,
      subtransactions:
        subs.length > 0
          ? subs.map((sub) => ({
              id: sub.id,
              scheduled_transaction_id: sub.scheduled_transaction_id,
              amount: formatCurrency(sub.amount),
              memo: sanitizeMemo(sub.memo),
              payee_id: sub.payee_id,
              category_id: sub.category_id,
              transfer_account_id: sub.transfer_account_id ?? null,
            }))
          : [],
    };
  });

  if (cursor !== undefined) {
    return JSON.stringify(
      {
        ...deltaFields(cursor, deletedIds),
        scheduled_transactions: formattedTransactions,
        summary: {
          changed_count: formattedTransactions.length,
          deleted_count: deletedIds.length,
          note: DELTA_SUMMARY_NOTE,
        },
        server_knowledge: response.data.server_knowledge,
      },
      null,
      2
    );
  }

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
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
