/**
 * Create Transactions (Bulk) Tool
 *
 * Creates multiple transactions in a single request.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import { IMPORT_ID_MAX_LENGTH, MEMO_MAX_LENGTH, TXN_PAYEE_NAME_MAX_LENGTH, budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/server';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor, toMilliunits, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';
import {
  checkSplitRules,
  createdSubtransactionSchema,
  subtransactionsField,
  subtransactionsJsonSchema,
  subtransactionsSchema,
  toSaveSubTransactions,
} from './subtransactions.js';
import { toOutputSchema } from '../output-schema.js';
import { count, fromYnab, money } from '../schemas/common.js';

// Transaction schema for bulk creation
const transactionSchema = z
  .object({
    account_id: ynabId().describe('The account UUID for this transaction'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Transaction date in YYYY-MM-DD format'),
    amount: z
      .number()
      .describe('Amount in dollars (negative for outflow, positive for inflow)'),
    payee_id: ynabId().optional().describe('Payee UUID'),
    payee_name: z.string().max(TXN_PAYEE_NAME_MAX_LENGTH).optional().describe('Payee name'),
    category_id: ynabId().optional().describe('Category UUID'),
    memo: z.string().max(MEMO_MAX_LENGTH).optional().describe('Transaction memo'),
    cleared: z.enum(['cleared', 'uncleared', 'reconciled']).optional(),
    approved: z.boolean().optional(),
    flag_color: z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']).optional(),
    import_id: z.string().min(1).max(IMPORT_ID_MAX_LENGTH).optional().describe('Unique ID for import deduplication'),
    subtransactions: subtransactionsSchema.optional(),
  })
  .superRefine(checkSplitRules);

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transactions: z
    .array(transactionSchema)
    .min(1)
    .max(100)
    .describe('Array of transactions to create (max 100)'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const createTransactionsOutputSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  summary: z.object({ created_count: count(), duplicate_count: count(), total_amount: money() }),
  transactions: z.array(
    z.object({
      id: fromYnab(z.string()),
      date: fromYnab(z.string()),
      amount: money(),
      payee_name: z.string(),
      category_name: z.string(),
      subtransactions: z.array(createdSubtransactionSchema).exactOptional().describe('The splits; omitted when none'),
    })
  ),
  duplicate_import_ids: z
    .array(z.string())
    .exactOptional()
    .describe('import_ids that already existed, so those transactions were skipped; omitted when none'),
});
export type CreateTransactionsOutput = z.output<typeof createTransactionsOutputSchema>;

// Tool definition
export const createTransactionsTool: Tool = {
  name: 'ynab_create_transactions',
  description: `Create multiple transactions in a single request (bulk import).

Use when the user asks:
- "Import these transactions"
- "Add multiple transactions"
- "Bulk create transactions"
- "Import these transactions, one of them split across categories"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Maximum 100 transactions per request.
Use import_id to prevent duplicate imports.
Any item may carry subtransactions (at least 2, amounts in dollars) to create a split transaction: split amounts must sum exactly to that item's amount, and the item must not set category_id. YNAB cannot edit the splits of an existing transaction afterwards.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transactions: {
        type: 'array',
        description: 'Array of transactions to create',
        items: {
          type: 'object',
          properties: {
            account_id: { type: 'string', maxLength: 36, description: 'Account UUID' },
            date: { type: 'string', maxLength: 10, description: 'Date in YYYY-MM-DD format' },
            amount: { type: 'number', description: 'Amount in dollars' },
            payee_id: { type: 'string', maxLength: 36, description: 'Payee UUID' },
            payee_name: { type: 'string', maxLength: 200, description: 'Payee name' },
            category_id: { type: 'string', maxLength: 36, description: 'Category UUID' },
            memo: { type: 'string', maxLength: 500, description: 'Memo' },
            cleared: { type: 'string', enum: ['cleared', 'uncleared', 'reconciled'] },
            approved: { type: 'boolean' },
            flag_color: {
              type: 'string',
              enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
            },
            import_id: { type: 'string', minLength: 1, maxLength: 36, description: 'Unique ID for deduplication' },
            subtransactions: subtransactionsJsonSchema,
          },
          required: ['account_id', 'date', 'amount'],
        },
      },
    },
    required: ['transactions'],
  },
  outputSchema: toOutputSchema(createTransactionsOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_create_transactions tool.
 *
 * @param args - Tool arguments including transactions array (max 100)
 * @param client - YNAB client instance for API calls
 * @returns JSON string with created transactions and duplicate info
 *
 * @remarks
 * Uses the ynab.NewTransaction type for bulk transaction creation.
 * Enum types are cast to ynab.TransactionClearedStatus and ynab.TransactionFlagColor.
 * Security checks (rate limiting, write permission, audit logging) are handled by YnabClient.
 */
export async function handleCreateTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<CreateTransactionsOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id, { fresh: true });

  // Convert transactions to YNAB format
  const ynabTransactions: ynab.NewTransaction[] = validated.transactions.map((t) => {
    const txn: ynab.NewTransaction = {
      account_id: t.account_id,
      date: t.date,
      amount: toMilliunits(t.amount),
    };

    if (t.payee_id !== undefined) txn.payee_id = t.payee_id;
    if (t.payee_name !== undefined) txn.payee_name = t.payee_name;
    if (t.category_id !== undefined) txn.category_id = t.category_id;
    if (t.memo !== undefined) txn.memo = t.memo;
    if (t.cleared !== undefined) txn.cleared = t.cleared as ynab.TransactionClearedStatus;
    if (t.approved !== undefined) txn.approved = t.approved;
    if (t.flag_color !== undefined)
      txn.flag_color = t.flag_color as ynab.TransactionFlagColor;
    if (t.import_id !== undefined) txn.import_id = t.import_id;
    if (t.subtransactions !== undefined) txn.subtransactions = toSaveSubTransactions(t.subtransactions);

    return txn;
  });

  const response = await client.createTransaction(budgetId, {
    transactions: ynabTransactions,
  });

  const money = await moneyFormatterFor(client, budgetId);
  const created = response.data.transactions ?? [];
  const duplicates = response.data.duplicate_import_ids ?? [];

  // Calculate totals (guard for empty array when all are duplicates)
  const amounts = created.map((t) => t.amount);
  const totalAmount = created.length > 0 ? sumMilliunits(amounts) : 0;

  return {
    success: true,
    message: `Created ${created.length} transactions`,
    summary: {
      created_count: created.length,
      duplicate_count: duplicates.length,
      total_amount: money(totalAmount),
    },
    transactions: created.map((t) => ({
      id: t.id,
      date: t.date,
      amount: money(t.amount),
      payee_name: sanitizeName(t.payee_name),
      category_name: sanitizeName(t.category_name),
      ...subtransactionsField(t.subtransactions, money),
    })),
    ...(duplicates.length > 0
      ? { duplicate_import_ids: duplicates.map((id) => sanitizeString(id, 100) ?? '') }
      : {}),
  };
}
