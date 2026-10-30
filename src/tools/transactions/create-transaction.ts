/**
 * Create Transaction Tool
 *
 * Creates a new transaction in a budget.
 */

import { z } from 'zod';
import { IMPORT_ID_MAX_LENGTH, MEMO_MAX_LENGTH, budgetId, ynabId, TXN_PAYEE_NAME_MAX_LENGTH } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo, sanitizeString } from '../../utils/sanitize.js';
import {
  checkSplitRules,
  formatSubtransactions,
  subtransactionsJsonSchema,
  subtransactionsSchema,
  toSaveSubTransactions,
} from './subtransactions.js';

// Cleared status options
const clearedStatuses = ['cleared', 'uncleared', 'reconciled'] as const;

// Flag colors
const flagColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

// Input schema
const inputSchema = z
  .object({
    budget_id: budgetId()
      .optional()
      .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
    account_id: ynabId().describe('The account UUID for this transaction'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Transaction date in YYYY-MM-DD format'),
    amount: z
      .number()
      .describe(
        'Amount in dollars (negative for outflow, positive for inflow). E.g., -50.00 for a $50 expense'
      ),
    payee_id: ynabId().optional().describe('Payee UUID (use ynab_list_payees to find)'),
    payee_name: z
      .string()
      .max(TXN_PAYEE_NAME_MAX_LENGTH)
      .optional()
      .describe('Payee name (creates new payee if payee_id not provided)'),
    category_id: ynabId()
      .optional()
      .describe('Category UUID (use ynab_list_categories to find)'),
    memo: z.string().max(MEMO_MAX_LENGTH).optional().describe('Transaction memo/note'),
    cleared: z
      .enum(clearedStatuses)
      .optional()
      .describe('Cleared status: cleared, uncleared, or reconciled'),
    approved: z.boolean().optional().describe('Whether the transaction is approved'),
    flag_color: z.enum(flagColors).optional().describe('Flag color for the transaction'),
    import_id: z
      .string()
      .max(IMPORT_ID_MAX_LENGTH)
      .optional()
      .describe('Unique import ID for deduplication (max 36 chars). A repeat of an existing import_id is not created again'),
    subtransactions: subtransactionsSchema.optional(),
  })
  .superRefine(checkSplitRules);

// Tool definition
export const createTransactionTool: Tool = {
  name: 'ynab_create_transaction',
  description: `Create a new transaction in a budget.

Use when the user asks:
- "Add a transaction for $50 at Amazon"
- "Record a purchase"
- "Log an expense"
- "Create a transaction"

- "Split this $100 purchase between groceries and household"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Amount should be negative for expenses/outflows and positive for income/inflows.

Split transactions: pass subtransactions (at least 2, each with amount in dollars and optional payee_id/payee_name, category_id, memo). Split amounts must sum exactly to the parent amount, and the parent must not set category_id. The splits of an existing transaction cannot be edited afterwards (YNAB limitation), so get them right on creation.
Pass import_id to make the create idempotent: if that import_id already exists, nothing is created and duplicate_import_ids is returned.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      account_id: {
        type: 'string',
        maxLength: 36,
        description: 'The account UUID for this transaction',
      },
      date: {
        type: 'string',
        maxLength: 10,
        description: 'Transaction date in YYYY-MM-DD format',
      },
      amount: {
        type: 'number',
        description: 'Amount in dollars (negative for outflow, positive for inflow)',
      },
      payee_id: {
        type: 'string',
        maxLength: 36,
        description: 'Payee UUID',
      },
      payee_name: {
        type: 'string',
        maxLength: 200,
        description: 'Payee name (creates new payee if payee_id not provided)',
      },
      category_id: {
        type: 'string',
        maxLength: 36,
        description: 'Category UUID',
      },
      memo: {
        type: 'string',
        maxLength: 500,
        description: 'Transaction memo/note',
      },
      cleared: {
        type: 'string',
        enum: clearedStatuses,
        description: 'Cleared status',
      },
      approved: {
        type: 'boolean',
        description: 'Whether the transaction is approved',
      },
      flag_color: {
        type: 'string',
        enum: flagColors,
        description: 'Flag color',
      },
      import_id: {
        type: 'string',
        maxLength: IMPORT_ID_MAX_LENGTH,
        description: 'Unique import ID for deduplication (max 36 chars)',
      },
      subtransactions: subtransactionsJsonSchema,
    },
    required: ['account_id', 'date', 'amount'],
  },
};

// Handler function
/**
 * Handler for the ynab_create_transaction tool.
 *
 * @param args - Tool arguments including account_id, date, amount, and optional fields
 * @param client - YNAB client instance for API calls
 * @returns JSON string with created transaction details
 * @throws Error if transaction creation fails
 *
 * @remarks
 * Uses the ynab.NewTransaction type for creating transactions.
 * Enum types are cast to ynab.TransactionClearedStatus and ynab.TransactionFlagColor.
 * Security checks (rate limiting, write permission, audit logging) are handled by YnabClient.
 */
export async function handleCreateTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Build transaction data, only including defined fields
  const transactionData: ynab.NewTransaction = {
    account_id: validated.account_id,
    date: validated.date,
    amount: toMilliunits(validated.amount),
  };

  if (validated.payee_id !== undefined) transactionData.payee_id = validated.payee_id;
  if (validated.payee_name !== undefined) transactionData.payee_name = validated.payee_name;
  if (validated.category_id !== undefined) transactionData.category_id = validated.category_id;
  if (validated.memo !== undefined) transactionData.memo = validated.memo;
  if (validated.cleared !== undefined)
    transactionData.cleared = validated.cleared as ynab.TransactionClearedStatus;
  if (validated.approved !== undefined) transactionData.approved = validated.approved;
  if (validated.flag_color !== undefined)
    transactionData.flag_color = validated.flag_color as ynab.TransactionFlagColor;
  if (validated.import_id !== undefined) transactionData.import_id = validated.import_id;
  if (validated.subtransactions !== undefined)
    transactionData.subtransactions = toSaveSubTransactions(validated.subtransactions);

  const response = await client.createTransaction(budgetId, {
    transaction: transactionData,
  });

  const txn = response.data.transaction;

  if (txn == null) {
    // A repeated import_id is a normal outcome, not a failure: YNAB skips the create.
    const duplicates = response.data.duplicate_import_ids ?? [];
    if (validated.import_id !== undefined && duplicates.length > 0) {
      return JSON.stringify(
        {
          success: false,
          message: 'No transaction created: a transaction with this import_id already exists',
          duplicate_import_ids: duplicates.map((id) => sanitizeString(id, 100) ?? ''),
        },
        null,
        2
      );
    }
    throw new Error('Transaction creation failed: no transaction returned');
  }

  return JSON.stringify(
    {
      success: true,
      message: `Transaction created: ${formatCurrency(txn.amount)} at ${sanitizeName(txn.payee_name)}`,
      transaction: {
        id: txn.id,
        date: txn.date,
        amount: formatCurrency(txn.amount),
        payee_name: sanitizeName(txn.payee_name),
        category_name: sanitizeName(txn.category_name),
        account_name: sanitizeName(txn.account_name),
        memo: sanitizeMemo(txn.memo),
        cleared: txn.cleared,
        approved: txn.approved,
        subtransactions: formatSubtransactions(txn.subtransactions),
      },
    },
    null,
    2
  );
}
