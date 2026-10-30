/**
 * List Category Transactions Tool
 *
 * Returns transactions for a specific category.
 */

import { z } from 'zod';
import { DATE_TEXT_MAX_LENGTH, budgetId, ynabId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, deltaFields, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { parseNaturalDate } from '../../utils/dates.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import {
  transactionChainFields,
  transactionTypeJsonSchema,
  transactionTypeSchema,
  truncationSummary,
} from './format.js';

const DEFAULT_RANGE_NOTE =
  'since_date was not provided, so YNAB returned only the last 12 months of transactions. Pass an earlier since_date to see older history.';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  category_id: ynabId().describe('The category UUID to get transactions for'),
  since_date: z
    .string()
    .max(DATE_TEXT_MAX_LENGTH)
    .optional()
    .describe(
      'Only return transactions on or after this date. Accepts ISO dates (YYYY-MM-DD) or natural language like "past 30 days", "this month". If omitted, YNAB returns only the last 12 months; pass an earlier date for older history'
    ),
  until_date: z
    .string()
    .max(DATE_TEXT_MAX_LENGTH)
    .optional()
    .describe(
      'Only return transactions on or before this date (inclusive). Accepts ISO dates (YYYY-MM-DD) or "today" or "yesterday". Prefer ISO dates for an end bound: period names such as "last month" or "this year" resolve to the START of that period, so they would exclude most of it'
    ),
  type: transactionTypeSchema.optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Maximum number of transactions to return (default 100, max 500)'),
  since_server_knowledge: sinceServerKnowledge(),
});

// Tool definition
export const listCategoryTransactionsTool: Tool = {
  name: 'ynab_list_category_transactions',
  description: `List transactions for a specific category.

Use when the user asks:
- "Show my grocery transactions"
- "What did I spend on dining out?"
- "List transactions in [category name]"
- "Show unapproved transactions in the [category] category"

Pass type ("unapproved" or "uncategorized") to narrow to transactions that need attention.
Requires a category_id. Use ynab_list_categories first to find the category ID.

NOTE: If since_date is omitted, YNAB returns only the last 12 months of transactions (API 1.85 default). Pass an earlier since_date to see older history. until_date sets an inclusive upper bound.
Pass since_server_knowledge (the server_knowledge of an earlier response with the same filters) to get only the transactions changed since then.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      category_id: {
        type: 'string',
        maxLength: 36,
        description: 'The category UUID to get transactions for',
      },
      since_date: {
        type: 'string',
        maxLength: 100,
        description:
          'Only return transactions on or after this date. Accepts YYYY-MM-DD or natural language like "past 30 days". If omitted, YNAB returns only the last 12 months; pass an earlier date for older history',
      },
      until_date: {
        type: 'string',
        maxLength: 100,
        description:
          'Only return transactions on or before this date (inclusive). Accepts YYYY-MM-DD or "today" or "yesterday". Prefer ISO dates for an end bound: period names such as "last month" or "this year" resolve to the START of that period, so they would exclude most of it',
      },
      type: transactionTypeJsonSchema,
      limit: {
        type: 'integer',
        description: 'Maximum number of transactions to return (default 100, max 500)',
        minimum: 1,
        maximum: 500,
      },
      since_server_knowledge: sinceServerKnowledgeJsonSchema,
    },
    required: ['category_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_list_category_transactions tool.
 */
export async function handleListCategoryTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 100;

  // Parse natural language dates
  const sinceDate = validated.since_date ? parseNaturalDate(validated.since_date) : undefined;
  const untilDate = validated.until_date ? parseNaturalDate(validated.until_date) : undefined;

  const cursor = validated.since_server_knowledge;
  const response = await client.getCategoryTransactions(budgetId, validated.category_id, {
    sinceDate,
    untilDate,
    type: validated.type,
    ...(cursor !== undefined ? { lastKnowledgeOfServer: cursor } : {}),
  });
  const { changed, deletedIds } =
    cursor !== undefined
      ? splitDeleted(response.data.transactions, (t) => t.id)
      : { changed: response.data.transactions, deletedIds: [] };

  // Sort by date descending and apply limit (avoid mutating response)
  const totalCount = changed.length;
  const transactions = [...changed]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);

  // Calculate summary - only count outflows (negative amounts) as spending
  const outflows = transactions.filter((t) => t.amount < 0);
  const totalSpent = sumMilliunits(outflows.map((t) => Math.abs(t.amount)));

  // Group by payee - only count outflows, sanitize during aggregation
  const byPayee: Record<string, number> = {};
  for (const txn of outflows) {
    const payee = sanitizeName(txn.payee_name) ?? 'Unknown';
    byPayee[payee] = (byPayee[payee] ?? 0) + Math.abs(txn.amount);
  }

  // Top payees (already sanitized during aggregation)
  const topPayees = Object.entries(byPayee)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, amount]) => ({ name, amount: formatCurrency(amount) }));

  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: sanitizeMemo(txn.memo),
    payee_name: sanitizeName(txn.payee_name),
    account_name: sanitizeName(txn.account_name),
    cleared: txn.cleared,
    approved: txn.approved,
    flag_color: txn.flag_color,
    ...transactionChainFields(txn),
    // 'subtransaction' rows are splits of parent_transaction_id
    type: txn.type,
    parent_transaction_id: txn.parent_transaction_id ?? null,
  }));

  const rangeNote = validated.since_date === undefined ? { date_range_note: DEFAULT_RANGE_NOTE } : {};
  return JSON.stringify(
    {
      ...(cursor !== undefined ? deltaFields(cursor, deletedIds) : {}),
      category_id: validated.category_id,
      transactions: formattedTransactions,
      summary:
        cursor !== undefined
          ? {
              count: formattedTransactions.length,
              ...truncationSummary(totalCount, formattedTransactions.length),
              deleted_count: deletedIds.length,
              ...rangeNote,
              note: DELTA_SUMMARY_NOTE,
            }
          : {
              count: formattedTransactions.length,
              ...truncationSummary(totalCount, formattedTransactions.length),
              ...rangeNote,
              total_spent: formatCurrency(totalSpent),
              top_payees: topPayees,
            },
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
