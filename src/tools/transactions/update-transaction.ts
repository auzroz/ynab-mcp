/**
 * Update Transaction Tool
 *
 * Updates an existing transaction.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';

// Cleared status options
const clearedStatuses = ['cleared', 'uncleared', 'reconciled'] as const;

// Flag colors
const flagColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transaction_id: z.string().uuid().describe('The transaction UUID to update'),
  account_id: z.string().optional().describe('New account UUID'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('New transaction date in YYYY-MM-DD format'),
  amount: z
    .number()
    .optional()
    .describe('New amount in dollars (negative for outflow, positive for inflow)'),
  payee_id: z.string().optional().describe('New payee UUID'),
  payee_name: z.string().optional().describe('New payee name'),
  category_id: z.string().optional().describe('New category UUID'),
  memo: z.string().max(200).optional().describe('New memo/note'),
  cleared: z.enum(clearedStatuses).optional().describe('New cleared status'),
  approved: z.boolean().optional().describe('New approved status'),
  flag_color: z.enum(flagColors).nullable().optional().describe('New flag color (null to remove)'),
});

// Tool definition
export const updateTransactionTool: Tool = {
  name: 'ynab_update_transaction',
  description: `Update an existing transaction.

Use when the user asks:
- "Change the category on that transaction"
- "Update the amount"
- "Mark transaction as cleared"
- "Add a memo to the transaction"
- "Recategorize a transaction"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Only provide the fields you want to change.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transaction_id: {
        type: 'string',
        description: 'The transaction UUID to update',
      },
      account_id: {
        type: 'string',
        description: 'New account UUID',
      },
      date: {
        type: 'string',
        description: 'New transaction date in YYYY-MM-DD format',
      },
      amount: {
        type: 'number',
        description: 'New amount in dollars',
      },
      payee_id: {
        type: 'string',
        description: 'New payee UUID',
      },
      payee_name: {
        type: 'string',
        description: 'New payee name',
      },
      category_id: {
        type: 'string',
        description: 'New category UUID',
      },
      memo: {
        type: 'string',
        description: 'New memo/note',
      },
      cleared: {
        type: 'string',
        enum: clearedStatuses,
        description: 'New cleared status',
      },
      approved: {
        type: 'boolean',
        description: 'New approved status',
      },
      flag_color: {
        type: ['string', 'null'],
        enum: [...flagColors, null],
        description: 'New flag color (null to remove)',
      },
    },
    required: ['transaction_id'],
  },
};

// Handler function
export async function handleUpdateTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Build update object with only provided fields
  const updateData: Record<string, unknown> = {};

  if (validated.account_id !== undefined) updateData['account_id'] = validated.account_id;
  if (validated.date !== undefined) updateData['date'] = validated.date;
  if (validated.amount !== undefined) updateData['amount'] = toMilliunits(validated.amount);
  if (validated.payee_id !== undefined) updateData['payee_id'] = validated.payee_id;
  if (validated.payee_name !== undefined) updateData['payee_name'] = validated.payee_name;
  if (validated.category_id !== undefined) updateData['category_id'] = validated.category_id;
  if (validated.memo !== undefined) updateData['memo'] = validated.memo;
  if (validated.cleared !== undefined) updateData['cleared'] = validated.cleared;
  if (validated.approved !== undefined) updateData['approved'] = validated.approved;
  if (validated.flag_color !== undefined) updateData['flag_color'] = validated.flag_color;

  const response = await client.updateTransaction(budgetId, validated.transaction_id, {
    transaction: updateData,
  });

  const txn = response.data.transaction;

  return JSON.stringify(
    {
      success: true,
      message: `Transaction updated: ${formatCurrency(txn.amount)} at ${txn.payee_name ?? 'Unknown'}`,
      transaction: {
        id: txn.id,
        date: txn.date,
        amount: formatCurrency(txn.amount),
        payee_name: txn.payee_name,
        category_name: txn.category_name,
        account_name: txn.account_name,
        memo: txn.memo,
        cleared: txn.cleared,
        approved: txn.approved,
        flag_color: txn.flag_color,
      },
    },
    null,
    2
  );
}
