/**
 * Delete Transaction Tool
 *
 * Deletes a transaction from a budget.
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
  transaction_id: z.string().uuid().describe('The transaction UUID to delete'),
});

// Tool definition
export const deleteTransactionTool: Tool = {
  name: 'ynab_delete_transaction',
  description: `Delete a transaction from a budget.

Use when the user asks:
- "Delete that transaction"
- "Remove the transaction"
- "Cancel that purchase entry"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
This action cannot be undone.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transaction_id: {
        type: 'string',
        description: 'The transaction UUID to delete',
      },
    },
    required: ['transaction_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_delete_transaction tool.
 */
export async function handleDeleteTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.deleteTransaction(budgetId, validated.transaction_id);
  const txn = response.data.transaction;

  if (txn == null) {
    throw new Error('Transaction deletion failed: no transaction returned');
  }

  return JSON.stringify(
    {
      success: true,
      message: `Transaction deleted: ${formatCurrency(txn.amount)} at ${sanitizeName(txn.payee_name)} on ${txn.date}`,
      deleted_transaction: {
        id: txn.id,
        date: txn.date,
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
