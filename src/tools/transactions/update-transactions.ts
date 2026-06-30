/**
 * Update Transactions (Bulk) Tool
 *
 * Updates multiple existing transactions in a single request.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { toMilliunits } from '../../utils/milliunits.js';

// Cleared status / flag color options
const clearedStatuses = ['cleared', 'uncleared', 'reconciled'] as const;
const flagColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

const transactionUpdateSchema = z.object({
  id: z.string().uuid().describe('The UUID of the transaction to update'),
  account_id: z.string().uuid().optional().describe('New account UUID'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('New transaction date in YYYY-MM-DD format'),
  amount: z
    .number()
    .optional()
    .describe('New amount in dollars (negative for outflow, positive for inflow)'),
  payee_id: z.string().uuid().optional().describe('New payee UUID'),
  payee_name: z.string().max(500).optional().describe('New payee name'),
  category_id: z.string().uuid().optional().describe('New category UUID'),
  memo: z.string().max(500).optional().describe('New memo/note'),
  cleared: z.enum(clearedStatuses).optional().describe('New cleared status'),
  approved: z.boolean().optional().describe('New approved status'),
  flag_color: z.enum(flagColors).nullable().optional().describe('New flag color (null to remove)'),
});

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transactions: z
    .array(transactionUpdateSchema)
    .min(1)
    .max(100)
    .describe('Array of transactions to update (1-100). Each must include the transaction id.'),
});

// Tool definition
export const updateTransactionsTool: Tool = {
  name: 'ynab_update_transactions',
  description: `Update multiple existing transactions in a single request (up to 100).

Use when the user asks:
- "Recategorize all these transactions"
- "Mark these transactions as cleared"
- "Approve all imported transactions"

Each entry must include the transaction id. Use ynab_list_transactions first to find ids.
Amounts are in dollars (e.g., -42.50 for a $42.50 outflow).

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transactions: {
        type: 'array',
        description: 'Array of transactions to update (1-100). Each must include the transaction id.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The UUID of the transaction to update' },
            account_id: { type: 'string', description: 'New account UUID' },
            date: { type: 'string', description: 'New date in YYYY-MM-DD format' },
            amount: { type: 'number', description: 'New amount in dollars' },
            payee_id: { type: 'string', description: 'New payee UUID' },
            payee_name: { type: 'string', description: 'New payee name' },
            category_id: { type: 'string', description: 'New category UUID' },
            memo: { type: 'string', description: 'New memo/note' },
            cleared: { type: 'string', enum: [...clearedStatuses], description: 'New cleared status' },
            approved: { type: 'boolean', description: 'New approved status' },
            flag_color: {
              type: ['string', 'null'],
              enum: [...flagColors, null],
              description: 'New flag color (null to remove)',
            },
          },
          required: ['id'],
        },
      },
    },
    required: ['transactions'],
  },
};

// Handler function
/**
 * Handler for the ynab_update_transactions tool.
 */
export async function handleUpdateTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const transactions: ynab.SaveTransactionWithIdOrImportId[] = validated.transactions.map((t) => {
    const update: ynab.SaveTransactionWithIdOrImportId = { id: t.id };
    if (t.account_id !== undefined) update.account_id = t.account_id;
    if (t.date !== undefined) update.date = t.date;
    if (t.amount !== undefined) update.amount = toMilliunits(t.amount);
    if (t.payee_id !== undefined) update.payee_id = t.payee_id;
    if (t.payee_name !== undefined) update.payee_name = t.payee_name;
    if (t.category_id !== undefined) update.category_id = t.category_id;
    if (t.memo !== undefined) update.memo = t.memo;
    if (t.cleared !== undefined) update.cleared = t.cleared as ynab.TransactionClearedStatus;
    if (t.approved !== undefined) update.approved = t.approved;
    if (t.flag_color !== undefined)
      update.flag_color = t.flag_color as ynab.TransactionFlagColor | null;
    return update;
  });

  const response = await client.updateTransactions(budgetId, { transactions });

  return JSON.stringify(
    {
      success: true,
      message: `Updated ${response.data.transaction_ids.length} transaction(s)`,
      requested_count: transactions.length,
      updated_count: response.data.transaction_ids.length,
      transaction_ids: response.data.transaction_ids,
    },
    null,
    2
  );
}
