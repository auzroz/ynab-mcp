/**
 * Preview Scheduled Transaction Tool
 *
 * Generates a preview of a scheduled transaction without making changes.
 * Validates all inputs and returns estimated costs.
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
  amount: z
    .number()
    .describe(
      'Amount in dollars (negative for outflow, positive for inflow). E.g., -50.00 for a $50 expense'
    ),
  frequency: z
    .enum(frequencies)
    .describe('Recurrence frequency'),
  payee_id: z.string().uuid().optional().describe('Payee UUID'),
  payee_name: z
    .string()
    .max(200)
    .optional()
    .describe('Payee name (one of payee_id or payee_name should be provided)'),
  category_id: z
    .string()
    .uuid()
    .optional()
    .describe('Category UUID'),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Start date in YYYY-MM-DD format (defaults to next expected date based on frequency)'),
  memo: z.string().max(200).optional().describe('Transaction memo/note'),
  flag_color: z.enum(flagColors).optional().describe('Flag color'),
});

// Tool definition
export const previewScheduledTransactionTool: Tool = {
  name: 'ynab_preview_scheduled_transaction',
  description: `Preview a scheduled transaction before creating it.

Use when the user asks:
- "Show me what this scheduled transaction would look like"
- "Preview recurring payment"
- "What would this subscription cost annually?"
- "Validate scheduled transaction"

Validates all inputs and returns a preview with estimated costs.
Does NOT create anything - use ynab_create_scheduled_transaction to actually create.`,
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
        description: 'Payee name',
      },
      category_id: {
        type: 'string',
        description: 'Category UUID',
      },
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format',
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
    required: ['account_id', 'amount', 'frequency'],
  },
};

/**
 * Calculate the default start date based on frequency.
 */
function calculateDefaultStartDate(frequency: string): string {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Default to one interval from today
  switch (frequency) {
    case 'daily':
      today.setUTCDate(today.getUTCDate() + 1);
      break;
    case 'weekly':
      today.setUTCDate(today.getUTCDate() + 7);
      break;
    case 'everyOtherWeek':
      today.setUTCDate(today.getUTCDate() + 14);
      break;
    case 'twiceAMonth':
    case 'every4Weeks':
    case 'monthly':
      today.setUTCMonth(today.getUTCMonth() + 1);
      break;
    case 'everyOtherMonth':
      today.setUTCMonth(today.getUTCMonth() + 2);
      break;
    case 'every3Months':
      today.setUTCMonth(today.getUTCMonth() + 3);
      break;
    case 'every4Months':
      today.setUTCMonth(today.getUTCMonth() + 4);
      break;
    case 'twiceAYear':
      today.setUTCMonth(today.getUTCMonth() + 6);
      break;
    case 'yearly':
      today.setUTCFullYear(today.getUTCFullYear() + 1);
      break;
    case 'everyOtherYear':
      today.setUTCFullYear(today.getUTCFullYear() + 2);
      break;
    default:
      today.setUTCMonth(today.getUTCMonth() + 1);
  }

  return today.toISOString().split('T')[0] ?? '';
}

/**
 * Calculate next N occurrences from a start date based on frequency.
 */
function calculateNextOccurrences(startDate: string, frequency: string, count: number): string[] {
  const occurrences: string[] = [startDate];
  const [year, month, day] = startDate.split('-').map(Number);

  if (year === undefined || month === undefined || day === undefined) {
    return occurrences;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  for (let i = 1; i < count; i++) {
    switch (frequency) {
      case 'daily':
        date.setUTCDate(date.getUTCDate() + 1);
        break;
      case 'weekly':
        date.setUTCDate(date.getUTCDate() + 7);
        break;
      case 'everyOtherWeek':
        date.setUTCDate(date.getUTCDate() + 14);
        break;
      case 'twiceAMonth':
        date.setUTCDate(date.getUTCDate() + 15);
        break;
      case 'every4Weeks':
        date.setUTCDate(date.getUTCDate() + 28);
        break;
      case 'monthly':
        date.setUTCMonth(date.getUTCMonth() + 1);
        break;
      case 'everyOtherMonth':
        date.setUTCMonth(date.getUTCMonth() + 2);
        break;
      case 'every3Months':
        date.setUTCMonth(date.getUTCMonth() + 3);
        break;
      case 'every4Months':
        date.setUTCMonth(date.getUTCMonth() + 4);
        break;
      case 'twiceAYear':
        date.setUTCMonth(date.getUTCMonth() + 6);
        break;
      case 'yearly':
        date.setUTCFullYear(date.getUTCFullYear() + 1);
        break;
      case 'everyOtherYear':
        date.setUTCFullYear(date.getUTCFullYear() + 2);
        break;
      default:
        date.setUTCMonth(date.getUTCMonth() + 1);
    }

    const dateStr = date.toISOString().split('T')[0];
    if (dateStr) {
      occurrences.push(dateStr);
    }
  }

  return occurrences;
}

/**
 * Calculate monthly and annual costs based on amount and frequency.
 */
function calculateCosts(amountMilliunits: number, frequency: string): { monthly: number; annual: number } {
  const absAmount = Math.abs(amountMilliunits);

  let monthlyMultiplier: number;
  switch (frequency) {
    case 'daily':
      monthlyMultiplier = 30;
      break;
    case 'weekly':
      monthlyMultiplier = 4.33;
      break;
    case 'everyOtherWeek':
      monthlyMultiplier = 2.17;
      break;
    case 'twiceAMonth':
      monthlyMultiplier = 2;
      break;
    case 'every4Weeks':
      monthlyMultiplier = 30 / 28; // ~1.07 - 4 weeks (28 days) is slightly less than a month
      break;
    case 'monthly':
      monthlyMultiplier = 1;
      break;
    case 'everyOtherMonth':
      monthlyMultiplier = 0.5;
      break;
    case 'every3Months':
      monthlyMultiplier = 1 / 3;
      break;
    case 'every4Months':
      monthlyMultiplier = 0.25;
      break;
    case 'twiceAYear':
      monthlyMultiplier = 1 / 6;
      break;
    case 'yearly':
      monthlyMultiplier = 1 / 12;
      break;
    case 'everyOtherYear':
      monthlyMultiplier = 1 / 24;
      break;
    case 'never':
      monthlyMultiplier = 0;
      break;
    default:
      monthlyMultiplier = 1;
  }

  const monthly = absAmount * monthlyMultiplier;
  const annual = monthly * 12;

  return { monthly, annual };
}

/**
 * Human-readable frequency display name.
 */
function getFrequencyDisplay(frequency: string): string {
  const displayNames: Record<string, string> = {
    never: 'One-time',
    daily: 'Daily',
    weekly: 'Weekly',
    everyOtherWeek: 'Every Other Week',
    twiceAMonth: 'Twice a Month',
    every4Weeks: 'Every 4 Weeks',
    monthly: 'Monthly',
    everyOtherMonth: 'Every Other Month',
    every3Months: 'Quarterly',
    every4Months: 'Every 4 Months',
    twiceAYear: 'Twice a Year',
    yearly: 'Yearly',
    everyOtherYear: 'Every Other Year',
  };
  return displayNames[frequency] ?? frequency;
}

// Handler function
/**
 * Handler for the ynab_preview_scheduled_transaction tool.
 *
 * @param args - Tool arguments including account_id, amount, frequency, and optional fields
 * @param client - YNAB client instance for API calls
 * @returns JSON string with preview, validation status, and estimated costs
 */
export async function handlePreviewScheduledTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const validationErrors: string[] = [];

  // Determine start date
  const startDate = validated.start_date ?? calculateDefaultStartDate(validated.frequency);

  // Validate date
  const dateValidation = validateScheduledDate(startDate);
  if (!dateValidation.valid && dateValidation.error) {
    validationErrors.push(dateValidation.error);
  }

  // Validate payee
  if (!validated.payee_id && !validated.payee_name) {
    validationErrors.push('Either payee_id or payee_name must be provided');
  }

  // Fetch account details
  let accountName = 'Unknown Account';
  try {
    const accountResponse = await client.getAccountById(budgetId, validated.account_id);
    accountName = accountResponse.data.account.name;
  } catch {
    validationErrors.push(`Account not found: ${validated.account_id}`);
  }

  // Fetch category name if provided
  let categoryName: string | null = null;
  if (validated.category_id) {
    try {
      const categoryResponse = await client.getCategoryById(budgetId, validated.category_id);
      categoryName = categoryResponse.data.category.name;
    } catch {
      validationErrors.push(`Category not found: ${validated.category_id}`);
    }
  }

  // Fetch payee name if payee_id provided
  let payeeName = validated.payee_name ?? 'Unknown Payee';
  if (validated.payee_id) {
    try {
      const payeeResponse = await client.getPayeeById(budgetId, validated.payee_id);
      payeeName = payeeResponse.data.payee.name;
    } catch {
      validationErrors.push(`Payee not found: ${validated.payee_id}`);
    }
  }

  // Calculate milliunits and costs
  const amountMilliunits = toMilliunits(validated.amount);
  const costs = calculateCosts(amountMilliunits, validated.frequency);
  const nextOccurrences = calculateNextOccurrences(startDate, validated.frequency, 3);

  // Build the API payload that would be used for creation
  const apiPayload: ynab.SaveScheduledTransaction = {
    account_id: validated.account_id,
    date: startDate,
    amount: amountMilliunits,
    frequency: validated.frequency as ynab.ScheduledTransactionFrequency,
  };

  if (validated.payee_id) apiPayload.payee_id = validated.payee_id;
  if (validated.payee_name) apiPayload.payee_name = sanitizeName(validated.payee_name);
  if (validated.category_id) apiPayload.category_id = validated.category_id;
  if (validated.memo) apiPayload.memo = sanitizeMemo(validated.memo);
  if (validated.flag_color) apiPayload.flag_color = validated.flag_color as ynab.TransactionFlagColor;

  const isValid = validationErrors.length === 0;

  return JSON.stringify(
    {
      valid: isValid,
      preview: {
        account_name: sanitizeName(accountName),
        payee_name: sanitizeName(payeeName),
        category_name: categoryName ? sanitizeName(categoryName) : null,
        amount_display: formatCurrency(amountMilliunits),
        frequency_display: getFrequencyDisplay(validated.frequency),
        start_date: startDate,
        next_occurrences: nextOccurrences,
      },
      estimated_costs: {
        monthly: formatCurrency(Math.round(costs.monthly)),
        annual: formatCurrency(Math.round(costs.annual)),
      },
      ...(validationErrors.length > 0 && { validation_errors: validationErrors }),
      api_payload: apiPayload,
    },
    null,
    2
  );
}
