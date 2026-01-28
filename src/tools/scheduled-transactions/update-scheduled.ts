/**
 * Update Scheduled Transaction Tool
 *
 * Updates an existing scheduled transaction in a budget.
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
  scheduled_transaction_id: z
    .string()
    .uuid()
    .describe('The scheduled transaction UUID to update'),
  account_id: z.string().uuid().optional().describe('New account UUID'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('New date in YYYY-MM-DD format (must be future, max 5 years ahead)'),
  amount: z
    .number()
    .optional()
    .describe(
      'New amount in dollars (negative for outflow, positive for inflow)'
    ),
  frequency: z
    .enum(frequencies)
    .optional()
    .describe('New recurrence frequency'),
  payee_id: z.string().uuid().optional().describe('New payee UUID'),
  payee_name: z
    .string()
    .max(200)
    .optional()
    .describe('New payee name'),
  category_id: z
    .string()
    .uuid()
    .optional()
    .describe('New category UUID (Credit Card Payment categories NOT allowed)'),
  memo: z.string().max(200).optional().describe('New memo/note'),
  flag_color: z
    .enum(flagColors)
    .nullable()
    .optional()
    .describe('New flag color (null to remove flag)'),
});

// Tool definition
export const updateScheduledTransactionTool: Tool = {
  name: 'ynab_update_scheduled_transaction',
  description: `Update an existing scheduled transaction in a budget.

Use when the user asks:
- "Change my subscription amount"
- "Update recurring payment"
- "Modify scheduled transaction"
- "Change billing frequency"

Requires READ_ONLY mode to be disabled (YNAB_READ_ONLY=false).
Only provided fields will be updated.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      scheduled_transaction_id: {
        type: 'string',
        description: 'The scheduled transaction UUID to update',
      },
      account_id: {
        type: 'string',
        description: 'New account UUID',
      },
      date: {
        type: 'string',
        description: 'New date in YYYY-MM-DD format (must be future)',
      },
      amount: {
        type: 'number',
        description: 'New amount in dollars (negative for outflow, positive for inflow)',
      },
      frequency: {
        type: 'string',
        enum: frequencies,
        description: 'New recurrence frequency',
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
      flag_color: {
        type: ['string', 'null'],
        enum: [...flagColors, null],
        description: 'New flag color (null to remove)',
      },
    },
    required: ['scheduled_transaction_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_update_scheduled_transaction tool.
 *
 * @param args - Tool arguments including scheduled_transaction_id and optional update fields
 * @param client - YNAB client instance for API calls
 * @returns JSON string with updated scheduled transaction details
 * @throws Error if scheduled transaction update fails
 */
export async function handleUpdateScheduledTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Validate date constraints if date is being updated
  if (validated.date !== undefined) {
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
  }

  // Build update data, only including defined fields
  // SaveScheduledTransaction requires account_id and date, but for updates
  // we need to use the existing values if not provided
  const updateData: Partial<ynab.SaveScheduledTransaction> = {};

  if (validated.account_id !== undefined) updateData.account_id = validated.account_id;
  if (validated.date !== undefined) updateData.date = validated.date;
  if (validated.amount !== undefined) updateData.amount = toMilliunits(validated.amount);
  if (validated.frequency !== undefined)
    updateData.frequency = validated.frequency as ynab.ScheduledTransactionFrequency;
  if (validated.payee_id !== undefined) updateData.payee_id = validated.payee_id;
  if (validated.payee_name !== undefined) updateData.payee_name = validated.payee_name;
  if (validated.category_id !== undefined) updateData.category_id = validated.category_id;
  if (validated.memo !== undefined) updateData.memo = validated.memo;
  if (validated.flag_color !== undefined) {
    updateData.flag_color = validated.flag_color as ynab.TransactionFlagColor | null;
  }

  // Check if there are any fields to update
  if (Object.keys(updateData).length === 0) {
    return JSON.stringify(
      {
        success: false,
        error: 'No fields provided to update',
      },
      null,
      2
    );
  }

  const response = await client.updateScheduledTransaction(
    budgetId,
    validated.scheduled_transaction_id,
    {
      // Type assertion needed: SDK types require all fields but API accepts partial updates
      scheduled_transaction: updateData as ynab.SaveScheduledTransaction,
    }
  );

  const txn = response.data.scheduled_transaction;

  return JSON.stringify(
    {
      success: true,
      message: `Scheduled transaction updated: ${formatCurrency(txn.amount)} at ${sanitizeName(txn.payee_name)} (${txn.frequency})`,
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
