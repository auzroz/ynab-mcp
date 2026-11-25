/**
 * Delete Scheduled Transaction Tool
 *
 * Deletes a scheduled transaction from a budget.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import { budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { toOutputSchema } from '../output-schema.js';
import { fromYnab, money } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  scheduled_transaction_id: ynabId()
    .describe('The scheduled transaction UUID to delete'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const deleteScheduledTransactionOutputSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  deleted_scheduled_transaction: z.object({
    id: fromYnab(z.string()),
    date_first: fromYnab(z.string()),
    date_next: fromYnab(z.string()),
    frequency: fromYnab(z.string().describe('YNAB frequency, such as monthly or everyOtherWeek')),
    amount: money(),
    payee_name: z.string(),
    category_name: z.string(),
    account_name: z.string(),
  }),
});
export type DeleteScheduledTransactionOutput = z.output<typeof deleteScheduledTransactionOutputSchema>;

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
      scheduled_transaction_id: {
        type: 'string',
        maxLength: 36,
        description: 'The scheduled transaction UUID to delete',
      },
    },
    required: ['scheduled_transaction_id'],
  },
  outputSchema: toOutputSchema(deleteScheduledTransactionOutputSchema),
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
): Promise<DeleteScheduledTransactionOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id, { fresh: true });

  const response = await client.deleteScheduledTransaction(
    budgetId,
    validated.scheduled_transaction_id
  );
  const money = await moneyFormatterFor(client, budgetId);
  const txn = response.data.scheduled_transaction;

  return {
    success: true,
    message: `Scheduled transaction deleted: ${money(txn.amount)} at ${sanitizeName(txn.payee_name)} (${txn.frequency})`,
    deleted_scheduled_transaction: {
      id: txn.id,
      date_first: txn.date_first,
      date_next: txn.date_next,
      frequency: txn.frequency,
      amount: money(txn.amount),
      payee_name: sanitizeName(txn.payee_name),
      category_name: sanitizeName(txn.category_name),
      account_name: sanitizeName(txn.account_name),
    },
  };
}
