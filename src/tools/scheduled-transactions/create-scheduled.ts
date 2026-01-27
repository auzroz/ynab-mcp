/**
 * Create Scheduled Transaction Tool
 *
 * Creates a new scheduled transaction in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import { validateScheduledDate } from '../../utils/date-validation.js';
import { frequencies, flagColors } from '../../utils/scheduled-constants.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  account_id: z.string().uuid().describe('The account UUID for this scheduled transaction'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Start date in YYYY-MM-DD format (must be future, max 5 years ahead)'),
  amount: z
    .number()
    .describe(
      'Amount in dollars (negative for outflow, positive for inflow). E.g., -50.00 for a $50 expense'
    ),
  frequency: z
    .enum(frequencies)
    .describe(
      'Recurrence frequency: never, daily, weekly, everyOtherWeek, twiceAMonth, every4Weeks, monthly, everyOtherMonth, every3Months, every4Months, twiceAYear, yearly, everyOtherYear'
    ),
  payee_id: z.string().uuid().optional().describe('Payee UUID (use ynab_list_payees to find)'),
  payee_name: z
    .string()
    .max(200)
    .optional()
    .describe('Payee name (creates new payee if payee_id not provided)'),
  category_id: z
    .string()
    .uuid()
    .optional()
    .describe('Category UUID (use ynab_list_categories to find). Credit Card Payment categories NOT allowed.'),
  memo: z.string().max(200).optional().describe('Transaction memo/note'),
  flag_color: z.enum(flagColors).optional().describe('Flag color for the scheduled transaction'),
});

// Tool definition
export const createScheduledTransactionTool: Tool = {
  name: 'ynab_create_scheduled_transaction',
  description: `Create a new scheduled transaction (recurring bill, subscription, etc.) in a budget.

Use when the user asks:
- "Schedule a recurring payment"
- "Add a subscription"
- "Set up automatic bill"
- "Create scheduled transaction"
- "Convert recurring to scheduled"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Date must be in the future and within 5 years.
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
        description: 'The account UUID for this scheduled transaction',
      },
      date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format (must be future, max 5 years ahead)',
      },
      amount: {
        type: 'number',
        description: 'Amount in dollars (negative for outflow, positive for inflow)',
      },
      frequency: {
        type: 'string',
        enum: frequencies,
        description: 'Recurrence frequency',
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
        description: 'Category UUID (Credit Card Payment categories NOT allowed)',
      },
      memo: {
        type: 'string',
        description: 'Transaction memo/note',
      },
      flag_color: {
        type: 'string',
        enum: flagColors,
        description: 'Flag color',
      },
    },
    required: ['account_id', 'date', 'amount', 'frequency'],
  },
};

// Handler function
/**
 * Handler for the ynab_create_scheduled_transaction tool.
 *
 * @param args - Tool arguments including account_id, date, amount, frequency, and optional fields
 * @param client - YNAB client instance for API calls
 * @returns JSON string with created scheduled transaction details
 * @throws Error if scheduled transaction creation fails
 */
export async function handleCreateScheduledTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Validate date constraints
  const dateValidation = validateScheduledDate(validated.date);
  if (!dateValidation.valid) {
    return JSON.stringify(
      {
        success: false,
        error: dateValidation.error,
      },
      null,
      2
    );
  }

  // Build scheduled transaction data, only including defined fields
  const scheduledTransactionData: ynab.SaveScheduledTransaction = {
    account_id: validated.account_id,
    date: validated.date,
    amount: toMilliunits(validated.amount),
    frequency: validated.frequency as ynab.ScheduledTransactionFrequency,
  };

  if (validated.payee_id !== undefined) scheduledTransactionData.payee_id = validated.payee_id;
  if (validated.payee_name !== undefined) scheduledTransactionData.payee_name = validated.payee_name;
  if (validated.category_id !== undefined) scheduledTransactionData.category_id = validated.category_id;
  if (validated.memo !== undefined) scheduledTransactionData.memo = validated.memo;
  if (validated.flag_color !== undefined)
    scheduledTransactionData.flag_color = validated.flag_color as ynab.TransactionFlagColor;

  const response = await client.createScheduledTransaction(budgetId, {
    scheduled_transaction: scheduledTransactionData,
  });

  const txn = response.data.scheduled_transaction;

  return JSON.stringify(
    {
      success: true,
      message: `Scheduled transaction created: ${formatCurrency(txn.amount)} at ${sanitizeName(txn.payee_name)} (${txn.frequency})`,
      scheduled_transaction: {
        id: txn.id,
        date_first: txn.date_first,
        date_next: txn.date_next,
        frequency: txn.frequency,
        amount: formatCurrency(txn.amount),
        payee_name: sanitizeName(txn.payee_name),
        category_name: sanitizeName(txn.category_name),
        account_name: sanitizeName(txn.account_name),
        memo: sanitizeMemo(txn.memo),
        flag_color: txn.flag_color,
      },
    },
    null,
    2
  );
}
