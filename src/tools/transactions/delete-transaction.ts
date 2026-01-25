/**
 * Delete Transaction Tool
 *
 * Deletes a transaction from a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transaction_id: z.string().describe('The transaction UUID to delete'),
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
export async function handleDeleteTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.deleteTransaction(budgetId, validated.transaction_id);
  const txn = response.data.transaction;

  return JSON.stringify(
    {
      success: true,
      message: `Transaction deleted: ${formatCurrency(txn.amount)} at ${txn.payee_name ?? 'Unknown'} on ${txn.date}`,
      deleted_transaction: {
        id: txn.id,
        date: txn.date,
        amount: formatCurrency(txn.amount),
        payee_name: txn.payee_name,
        category_name: txn.category_name,
        account_name: txn.account_name,
      },
    },
    null,
    2
  );
}
