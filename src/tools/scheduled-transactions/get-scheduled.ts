/**
 * Get Scheduled Transaction Tool
 *
 * Returns details about a specific scheduled transaction.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  scheduled_transaction_id: z.string().describe('The scheduled transaction UUID to retrieve'),
});

// Tool definition
export const getScheduledTransactionTool: Tool = {
  name: 'ynab_get_scheduled_transaction',
  description: `Get details about a specific scheduled transaction.

Use when the user asks:
- "Show me details for that scheduled transaction"
- "What's the info on my Netflix subscription?"

Requires a scheduled_transaction_id. Use ynab_list_scheduled_transactions first to find the ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      scheduled_transaction_id: {
        type: 'string',
        description: 'The scheduled transaction UUID to retrieve',
      },
    },
    required: ['scheduled_transaction_id'],
  },
};

// Handler function
export async function handleGetScheduledTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getScheduledTransactionById(
    budgetId,
    validated.scheduled_transaction_id
  );
  const txn = response.data.scheduled_transaction;

  return JSON.stringify(
    {
      scheduled_transaction: {
        id: txn.id,
        date_first: txn.date_first,
        date_next: txn.date_next,
        frequency: txn.frequency,
        amount: formatCurrency(txn.amount),
        memo: sanitizeMemo(txn.memo),
        flag_color: txn.flag_color,
        account_id: txn.account_id,
        account_name: sanitizeName(txn.account_name),
        payee_id: txn.payee_id,
        payee_name: sanitizeName(txn.payee_name),
        category_id: txn.category_id,
        category_name: sanitizeName(txn.category_name),
        transfer_account_id: txn.transfer_account_id,
        deleted: txn.deleted,
        subtransactions:
          txn.subtransactions.length > 0
            ? txn.subtransactions.map((sub) => ({
                id: sub.id,
                amount: formatCurrency(sub.amount),
                memo: sanitizeMemo(sub.memo),
                payee_id: sub.payee_id,
                category_id: sub.category_id,
                transfer_account_id: sub.transfer_account_id,
              }))
            : [],
      },
    },
    null,
    2
  );
}
