/**
 * Delete Transaction Tool
 *
 * Deletes a transaction from a budget.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import { budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { toOutputSchema } from '../output-schema.js';
import { money } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transaction_id: ynabId().describe('The transaction UUID to delete'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const deleteTransactionOutputSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  deleted_transaction: z.object({
    id: z.string(),
    date: z.string(),
    amount: money(),
    payee_name: z.string(),
    category_name: z.string(),
    account_name: z.string(),
  }),
});
export type DeleteTransactionOutput = z.output<typeof deleteTransactionOutputSchema>;

// Tool definition
export const deleteTransactionTool: Tool = {
  name: 'ynab_delete_transaction',
  description: `Delete a transaction from a budget.

Use when the user asks:
- "Delete that transaction"
- "Remove the transaction"
- "Cancel that purchase entry"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
This action cannot be undone.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transaction_id: {
        type: 'string',
        maxLength: 36,
        description: 'The transaction UUID to delete',
      },
    },
    required: ['transaction_id'],
  },
  outputSchema: toOutputSchema(deleteTransactionOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_delete_transaction tool.
 */
export async function handleDeleteTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<DeleteTransactionOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id, { fresh: true });

  const response = await client.deleteTransaction(budgetId, validated.transaction_id);
  const money = await moneyFormatterFor(client, budgetId);
  const txn = response.data.transaction;

  if (txn == null) {
    throw new Error('Transaction deletion failed: no transaction returned');
  }

  return {
    success: true,
    message: `Transaction deleted: ${money(txn.amount)} at ${sanitizeName(txn.payee_name)} on ${txn.date}`,
    deleted_transaction: {
      id: txn.id,
      date: txn.date,
      amount: money(txn.amount),
      payee_name: sanitizeName(txn.payee_name),
      category_name: sanitizeName(txn.category_name),
      account_name: sanitizeName(txn.account_name),
    },
  };
}
