/**
 * Delete Scheduled Transaction Tool
 *
 * Deletes a scheduled transaction from a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  scheduled_transaction_id: z
    .string()
    .uuid()
    .describe('The scheduled transaction UUID to delete'),
});

// Tool definition
export const deleteScheduledTransactionTool: Tool = {
  name: 'ynab_delete_scheduled_transaction',
  description: `Delete a scheduled transaction from a budget.

Use when the user asks:
- "Delete that scheduled transaction"
- "Remove the recurring payment"
- "Cancel that subscription"
- "Stop the scheduled bill"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
This action cannot be undone.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      scheduled_transaction_id: {
        type: 'string',
        description: 'The scheduled transaction UUID to delete',
      },
    },
    required: ['scheduled_transaction_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_delete_scheduled_transaction tool.
 *
 * @param args - Tool arguments including scheduled_transaction_id
 * @param client - YNAB client instance for API calls
 * @returns JSON string with deleted scheduled transaction details
 * @throws Error if scheduled transaction deletion fails
 */
export async function handleDeleteScheduledTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.deleteScheduledTransaction(
    budgetId,
    validated.scheduled_transaction_id
  );
  const txn = response.data.scheduled_transaction;

  return JSON.stringify(
    {
      success: true,
      message: `Scheduled transaction deleted: ${formatCurrency(txn.amount)} at ${sanitizeName(txn.payee_name)} (${txn.frequency})`,
      deleted_scheduled_transaction: {
        id: txn.id,
        date_first: txn.date_first,
        date_next: txn.date_next,
        frequency: txn.frequency,
        amount: formatCurrency(txn.amount),
        payee_name: sanitizeName(txn.payee_name),
        category_name: sanitizeName(txn.category_name),
        account_name: sanitizeName(txn.account_name),
      },
    },
    null,
    2
  );
}
