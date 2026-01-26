/**
 * Create Transaction Tool
 *
 * Creates a new transaction in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

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
  account_id: z.string().uuid().describe('The account UUID for this transaction'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Transaction date in YYYY-MM-DD format'),
  amount: z
    .number()
    .describe(
      'Amount in dollars (negative for outflow, positive for inflow). E.g., -50.00 for a $50 expense'
    ),
  payee_id: z.string().uuid().optional().describe('Payee UUID (use ynab_list_payees to find)'),
  payee_name: z
    .string()
    .optional()
    .describe('Payee name (creates new payee if payee_id not provided)'),
  category_id: z
    .string()
    .uuid()
    .optional()
    .describe('Category UUID (use ynab_list_categories to find)'),
  memo: z.string().max(200).optional().describe('Transaction memo/note'),
  cleared: z
    .enum(clearedStatuses)
    .optional()
    .describe('Cleared status: cleared, uncleared, or reconciled'),
  approved: z.boolean().optional().describe('Whether the transaction is approved'),
  flag_color: z.enum(flagColors).optional().describe('Flag color for the transaction'),
});

// Tool definition
export const createTransactionTool: Tool = {
  name: 'ynab_create_transaction',
  description: `Create a new transaction in a budget.

Use when the user asks:
- "Add a transaction for $50 at Amazon"
- "Record a purchase"
- "Log an expense"
- "Create a transaction"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Amount should be negative for expenses/outflows and positive for income/inflows.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      account_id: {
        type: 'string',
        description: 'The account UUID for this transaction',
      },
      date: {
        type: 'string',
        description: 'Transaction date in YYYY-MM-DD format',
      },
      amount: {
        type: 'number',
        description: 'Amount in dollars (negative for outflow, positive for inflow)',
      },
      payee_id: {
        type: 'string',
        description: 'Payee UUID',
      },
      payee_name: {
        type: 'string',
        description: 'Payee name (creates new payee if payee_id not provided)',
      },
      category_id: {
        type: 'string',
        description: 'Category UUID',
      },
      memo: {
        type: 'string',
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
 * Uses ynab.NewTransaction type (SDK v2) for creating transactions.
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

  const response = await client.createTransaction(budgetId, {
    transaction: transactionData,
  });

  const txn = response.data.transaction;

  if (txn == null) {
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
      },
    },
    null,
    2
  );
}
