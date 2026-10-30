/**
 * List Transactions Tool
 *
 * Returns transactions for a budget with optional filters.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { parseNaturalDate } from '../../utils/dates.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import {
  formatSubtransaction,
  transactionChainFields,
  transactionTypeJsonSchema,
  transactionTypeSchema,
} from './format.js';
import { DATE_TEXT_MAX_LENGTH, budgetId, monthParam } from '../../utils/schemas.js';

const DEFAULT_RANGE_NOTE =
  'since_date was not provided, so YNAB returned only the last 12 months of transactions. Pass an earlier since_date to see older history.';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: monthParam()
    .optional()
    .describe(
      'Only return transactions in this budget month: YYYY-MM-01 (first of month) or "current". Uses YNAB\'s month endpoint (pending transactions excluded). May be combined with since_date/until_date to narrow within the month'
    ),
  since_date: z
    .string()
    .max(DATE_TEXT_MAX_LENGTH)
    .optional()
    .describe(
      'Only return transactions on or after this date. Accepts ISO dates (YYYY-MM-DD) or natural language: "today", "yesterday", "this week", "last week", "this month", "last month", "past 7 days", "past 30 days". If omitted, YNAB returns only the last 12 months; pass an earlier date for older history'
    ),
  type: transactionTypeSchema.optional(),
  until_date: z
    .string()
    .max(DATE_TEXT_MAX_LENGTH)
    .optional()
    .describe(
      'Only return transactions on or before this date (inclusive). Accepts ISO dates (YYYY-MM-DD) or "today" or "yesterday". Prefer ISO dates for an end bound: period names such as "last month" or "this year" resolve to the START of that period, so they would exclude most of it'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Maximum number of transactions to return (default 100, max 500)'),
});

// Tool definition
export const listTransactionsTool: Tool = {
  name: 'ynab_list_transactions',
  description: `List transactions for a budget with optional filters.

Use when the user asks:
- "Show my recent transactions"
- "What did I spend this month?"
- "List my uncategorized transactions"
- "Show transactions since [date]"
- "What purchases have I made recently?"
- "Show all transactions for March" (month: "2024-03-01")
- "Show me the past 7 days of transactions"
- "What did I spend last week?"

Supports filtering by date (ISO or natural language like "past 30 days", "this month") and type (uncategorized/unapproved).
Returns transaction details including date, payee, amount, category, and status.

NOTE: If since_date is omitted, YNAB returns only the last 12 months of transactions (API 1.85 default). Pass an earlier since_date to see older history. until_date sets an inclusive upper bound.
Pass month (YYYY-MM-01 or "current") to list a single budget month instead of the default 12-month window; it can be narrowed further with since_date/until_date.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      month: {
        type: 'string',
        maxLength: 10,
        description:
          'Only return transactions in this budget month: YYYY-MM-01 (first of month) or "current". Pending transactions are excluded. May be combined with since_date/until_date to narrow within the month',
      },
      since_date: {
        type: 'string',
        maxLength: 100,
        description:
          'Only return transactions on or after this date. Accepts YYYY-MM-DD or natural language: "today", "this week", "past 30 days", etc.. If omitted, YNAB returns only the last 12 months; pass an earlier date for older history',
      },
      type: transactionTypeJsonSchema,
      until_date: {
        type: 'string',
        maxLength: 100,
        description:
          'Only return transactions on or before this date (inclusive). Accepts YYYY-MM-DD or "today" or "yesterday". Prefer ISO dates for an end bound: period names such as "last month" or "this year" resolve to the START of that period, so they would exclude most of it',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of transactions to return (default 100, max 500)',
      },
    },
  },
};

// Handler function
/**
 * Handler for the ynab_list_transactions tool.
 */
export async function handleListTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 100;

  const options: {
    sinceDate?: string;
    untilDate?: string;
    type?: 'uncategorized' | 'unapproved';
  } = {};
  if (validated.since_date !== undefined) {
    // Parse natural language dates like "past 7 days", "this month", etc.
    options.sinceDate = parseNaturalDate(validated.since_date);
  }
  if (validated.until_date !== undefined) {
    options.untilDate = parseNaturalDate(validated.until_date);
  }
  if (validated.type !== undefined) {
    options.type = validated.type;
  }

  const response =
    validated.month === undefined
      ? await client.getTransactions(budgetId, options)
      : await client.getTransactionsByMonth(budgetId, validated.month, options);

  let transactions = response.data.transactions;

  // Sort by date descending (most recent first)
  transactions.sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateB - dateA;
  });

  // Apply limit
  transactions = transactions.slice(0, limit);

  // Calculate summary stats
  const inflow = transactions.filter((t) => t.amount > 0);
  const outflow = transactions.filter((t) => t.amount < 0);
  const totalInflow = sumMilliunits(inflow.map((t) => t.amount));
  const totalOutflow = sumMilliunits(outflow.map((t) => Math.abs(t.amount)));

  // Format transactions
  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: sanitizeMemo(txn.memo),
    payee_name: sanitizeName(txn.payee_name),
    category_name: sanitizeName(txn.category_name),
    account_name: sanitizeName(txn.account_name),
    cleared: txn.cleared,
    approved: txn.approved,
    flag_color: txn.flag_color,
    ...transactionChainFields(txn),
    subtransactions:
      (txn.subtransactions ?? []).length > 0
        ? (txn.subtransactions ?? []).map(formatSubtransaction)
        : undefined,
  }));

  // Date range
  const dates = transactions.map((t) => t.date);
  const minDate = dates.length > 0 ? dates[dates.length - 1] : null;
  const maxDate = dates.length > 0 ? dates[0] : null;

  return JSON.stringify(
    {
      transactions: formattedTransactions,
      summary: {
        count: formattedTransactions.length,
        total_inflow: formatCurrency(totalInflow),
        total_outflow: formatCurrency(totalOutflow),
        net: formatCurrency(totalInflow - totalOutflow),
        date_range: minDate && maxDate ? { from: minDate, to: maxDate } : null,
        ...(validated.since_date === undefined && validated.month === undefined ? { date_range_note: DEFAULT_RANGE_NOTE } : {}),
      },
      filters_applied: {
        month: validated.month ?? null,
        since_date: validated.since_date
          ? { input: validated.since_date, parsed: options.sinceDate }
          : null,
        until_date: validated.until_date
          ? { input: validated.until_date, parsed: options.untilDate }
          : null,
        type: validated.type ?? null,
        limit,
      },
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
