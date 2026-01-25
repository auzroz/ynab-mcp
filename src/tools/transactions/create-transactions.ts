/**
 * Create Transactions (Bulk) Tool
 *
 * Creates multiple transactions in a single request.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Transaction schema for bulk creation
const transactionSchema = z.object({
  account_id: z.string().uuid().describe('The account UUID for this transaction'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Transaction date in YYYY-MM-DD format'),
  amount: z
    .number()
    .describe('Amount in dollars (negative for outflow, positive for inflow)'),
  payee_id: z.string().uuid().optional().describe('Payee UUID'),
  payee_name: z.string().optional().describe('Payee name'),
  category_id: z.string().uuid().optional().describe('Category UUID'),
  memo: z.string().max(200).optional().describe('Transaction memo'),
  cleared: z.enum(['cleared', 'uncleared', 'reconciled']).optional(),
  approved: z.boolean().optional(),
  flag_color: z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']).optional(),
  import_id: z.string().optional().describe('Unique ID for import deduplication'),
});

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transactions: z
    .array(transactionSchema)
    .min(1)
    .max(100)
    .describe('Array of transactions to create (max 100)'),
});

// Tool definition
export const createTransactionsTool: Tool = {
  name: 'ynab_create_transactions',
  description: `Create multiple transactions in a single request (bulk import).

Use when the user asks:
- "Import these transactions"
- "Add multiple transactions"
- "Bulk create transactions"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Maximum 100 transactions per request.
Use import_id to prevent duplicate imports.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transactions: {
        type: 'array',
        description: 'Array of transactions to create',
        items: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'Account UUID' },
            date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
            amount: { type: 'number', description: 'Amount in dollars' },
            payee_id: { type: 'string', description: 'Payee UUID' },
            payee_name: { type: 'string', description: 'Payee name' },
            category_id: { type: 'string', description: 'Category UUID' },
            memo: { type: 'string', description: 'Memo' },
            cleared: { type: 'string', enum: ['cleared', 'uncleared', 'reconciled'] },
            approved: { type: 'boolean' },
            flag_color: {
              type: 'string',
              enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
            },
            import_id: { type: 'string', description: 'Unique ID for deduplication' },
          },
          required: ['account_id', 'date', 'amount'],
        },
      },
    },
    required: ['transactions'],
  },
};

// Handler function
export async function handleCreateTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Convert transactions to YNAB format
  const ynabTransactions: ynab.SaveTransaction[] = validated.transactions.map((t) => {
    const txn: ynab.SaveTransaction = {
      account_id: t.account_id,
      date: t.date,
      amount: toMilliunits(t.amount),
    };

    if (t.payee_id !== undefined) txn.payee_id = t.payee_id;
    if (t.payee_name !== undefined) txn.payee_name = t.payee_name;
    if (t.category_id !== undefined) txn.category_id = t.category_id;
    if (t.memo !== undefined) txn.memo = t.memo;
    if (t.cleared !== undefined) txn.cleared = t.cleared as unknown as ynab.SaveTransaction.ClearedEnum;
    if (t.approved !== undefined) txn.approved = t.approved;
    if (t.flag_color !== undefined)
      txn.flag_color = t.flag_color as unknown as ynab.SaveTransaction.FlagColorEnum;
    if (t.import_id !== undefined) txn.import_id = t.import_id;

    return txn;
  });

  const response = await client.createTransaction(budgetId, {
    transactions: ynabTransactions,
  });

  const created = response.data.transactions ?? [];
  const duplicates = response.data.duplicate_import_ids ?? [];

  // Calculate totals
  const amounts = created.map((t) => t.amount);
  const totalAmount = sumMilliunits(amounts);

  return JSON.stringify(
    {
      success: true,
      message: `Created ${created.length} transactions`,
      summary: {
        created_count: created.length,
        duplicate_count: duplicates.length,
        total_amount: formatCurrency(totalAmount),
      },
      transactions: created.map((t) => ({
        id: t.id,
        date: t.date,
        amount: formatCurrency(t.amount),
        payee_name: sanitizeName(t.payee_name),
        category_name: sanitizeName(t.category_name),
      })),
      duplicate_import_ids: duplicates.length > 0 ? duplicates : undefined,
    },
    null,
    2
  );
}
