/**
 * List Account Transactions Tool
 *
 * Returns transactions for a specific account.
 */

import { z } from 'zod';
import { DATE_TEXT_MAX_LENGTH, budgetId, ynabId } from '../../utils/schemas.js';
import {
  deltaFields,
  sinceServerKnowledge,
  sinceServerKnowledgeJsonSchema,
  splitDeleted,
  transactionDeltaResult,
} from '../../utils/delta.js';
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
  truncationSummary,
} from './format.js';

const DEFAULT_RANGE_NOTE =
  'since_date was not provided, so YNAB returned only the last 12 months of transactions. Pass an earlier since_date to see older history.';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  account_id: ynabId().describe('The account UUID to get transactions for'),
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
export const listAccountTransactionsTool: Tool = {
  name: 'ynab_list_account_transactions',
  description: `List transactions for a specific account.

Use when the user asks:
- "Show transactions for my checking account"
- "What purchases were made on my credit card?"
- "List activity in [account name]"
- "Which transactions in my checking account are unapproved?"
- "Show uncategorized transactions in [account name]"

Pass type ("unapproved" or "uncategorized") to narrow to transactions that need attention.
Requires an account_id. Use ynab_list_accounts first to find the account ID.

NOTE: If since_date is omitted, YNAB returns only the last 12 months of transactions (API 1.85 default). Pass an earlier since_date to see older history. until_date sets an inclusive upper bound.
Pass since_server_knowledge (the server_knowledge of an earlier response with the same filters) to get only the transactions changed since then. If more changed than limit, the response keeps your cursor (cursor_withheld: true) so nothing is skipped. A delta may leave out a transaction that changed so it no longer matches the filters; re-read in full to keep a filtered list exact.`,
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
        description: 'The account UUID to get transactions for',
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
        type: 'number',
        description: 'Maximum number of transactions to return (default 100, max 500)',
      },
      since_server_knowledge: sinceServerKnowledgeJsonSchema,
    },
    required: ['account_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_list_account_transactions tool.
 */
export async function handleListAccountTransactions(
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
  const response = await client.getAccountTransactions(budgetId, validated.account_id, {
    sinceDate,
    untilDate,
    type: validated.type,
    ...(cursor !== undefined ? { lastKnowledgeOfServer: cursor } : {}),
  });
  const { changed, deletedIds } =
    cursor !== undefined
      ? splitDeleted(response.data.transactions, (t) => t.id)
      : { changed: response.data.transactions, deletedIds: [] };

  let transactions = changed;

  // Sort by date descending
  transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Apply limit
  const totalCount = transactions.length;
  transactions = transactions.slice(0, limit);

  // Calculate summary
  const inflow = transactions.filter((t) => t.amount > 0);
  const outflow = transactions.filter((t) => t.amount < 0);
  const totalInflow = sumMilliunits(inflow.map((t) => t.amount));
  const totalOutflow = sumMilliunits(outflow.map((t) => Math.abs(t.amount)));

  const formattedTransactions = transactions.map((txn) => ({
    id: txn.id,
    date: txn.date,
    amount: formatCurrency(txn.amount),
    memo: sanitizeMemo(txn.memo),
    payee_name: sanitizeName(txn.payee_name),
    category_name: sanitizeName(txn.category_name),
    cleared: txn.cleared,
    approved: txn.approved,
    flag_color: txn.flag_color,
    ...transactionChainFields(txn),
    // A delta may list removed split lines as deleted.
    subtransactions:
      (txn.subtransactions ?? []).some((sub) => !sub.deleted)
        ? (txn.subtransactions ?? []).filter((sub) => !sub.deleted).map(formatSubtransaction)
        : undefined,
  }));

  const rangeNote = validated.since_date === undefined ? { date_range_note: DEFAULT_RANGE_NOTE } : {};
  const delta = transactionDeltaResult(
    cursor,
    response.data.server_knowledge,
    totalCount > formattedTransactions.length
  );
  return JSON.stringify(
    {
      ...(cursor !== undefined ? deltaFields(cursor, deletedIds) : {}),
      account_id: validated.account_id,
      transactions: formattedTransactions,
      summary:
        cursor !== undefined
          ? {
              count: formattedTransactions.length,
              ...truncationSummary(totalCount, formattedTransactions.length),
              deleted_count: deletedIds.length,
              ...rangeNote,
              ...delta.summary,
            }
          : {
              count: formattedTransactions.length,
              ...truncationSummary(totalCount, formattedTransactions.length),
              ...rangeNote,
              total_inflow: formatCurrency(totalInflow),
              total_outflow: formatCurrency(totalOutflow),
              net: formatCurrency(totalInflow - totalOutflow),
            },
      ...delta.cursor,
    },
    null,
    2
  );
}
