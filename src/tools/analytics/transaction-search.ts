/**
 * Transaction Search Tool
 *
 * Powerful search across transactions with multiple filters.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { parseNaturalDate } from '../../utils/dates.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  query: z
    .string()
    .max(500)
    .optional()
    .describe('Search text to match in payee name, memo, or category'),
  payee: z.string().max(200).optional().describe('Filter by payee name (partial match)'),
  category: z.string().max(200).optional().describe('Filter by category name (partial match)'),
  min_amount: z
    .number()
    .optional()
    .describe('Minimum transaction amount in dollars (absolute value)'),
  max_amount: z
    .number()
    .optional()
    .describe('Maximum transaction amount in dollars (absolute value)'),
  since_date: z
    .string()
    .optional()
    .describe('Start date (YYYY-MM-DD or natural language like "last month")'),
  until_date: z
    .string()
    .optional()
    .describe('End date (YYYY-MM-DD or natural language)'),
  type: z
    .enum(['all', 'inflow', 'outflow'])
    .optional()
    .describe('Filter by transaction type (default: all)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum results to return (default 25)'),
});

// Tool definition
export const transactionSearchTool: Tool = {
  name: 'ynab_transaction_search',
  description: `Search transactions with powerful filtering options.

Use when the user asks:
- "Find transactions at [store]"
- "Search for [keyword] in my transactions"
- "Transactions over $100"
- "What did I spend on [category]?"
- "Find large purchases"
- "Search my expenses"

Supports filtering by payee, category, amount range, date range, and text search.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      query: {
        type: 'string',
        description: 'Search text to match in payee name, memo, or category',
      },
      payee: {
        type: 'string',
        description: 'Filter by payee name (partial match)',
      },
      category: {
        type: 'string',
        description: 'Filter by category name (partial match)',
      },
      min_amount: {
        type: 'number',
        description: 'Minimum transaction amount in dollars (absolute value)',
      },
      max_amount: {
        type: 'number',
        description: 'Maximum transaction amount in dollars (absolute value)',
      },
      since_date: {
        type: 'string',
        description: 'Start date (YYYY-MM-DD or natural language)',
      },
      until_date: {
        type: 'string',
        description: 'End date (YYYY-MM-DD or natural language)',
      },
      type: {
        type: 'string',
        enum: ['all', 'inflow', 'outflow'],
        description: 'Filter by transaction type',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default 25)',
      },
    },
    required: [],
  },
};

interface SearchResult {
  date: string;
  payee: string;
  category: string | null;
  amount: string;
  amount_raw: number;
  memo: string | null;
  account: string;
  cleared: string;
}

// Handler function
/**
 * Handler for the ynab_transaction_search tool.
 */
export async function handleTransactionSearch(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const limit = validated.limit ?? 25;
  const type = validated.type ?? 'all';

  // Parse dates
  const sinceDate = validated.since_date
    ? parseNaturalDate(validated.since_date)
    : undefined;
  const untilDate = validated.until_date
    ? parseNaturalDate(validated.until_date)
    : undefined;

  // Fetch data
  const transactionOptions: { sinceDate?: string } = {};
  if (sinceDate) {
    transactionOptions.sinceDate = sinceDate;
  }

  const [transactionsResponse, categoriesResponse, accountsResponse] = await Promise.all([
    client.getTransactions(budgetId, transactionOptions),
    client.getCategories(budgetId),
    client.getAccounts(budgetId),
  ]);

  // Build lookups
  const categoryLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      categoryLookup.set(cat.id, cat.name);
    }
  }

  const accountLookup = new Map<string, string>();
  for (const account of accountsResponse.data.accounts) {
    accountLookup.set(account.id, account.name);
  }

  // Filter transactions
  let transactions = transactionsResponse.data.transactions.filter((t) => !t.deleted);

  // Apply date filter for until_date
  if (untilDate) {
    transactions = transactions.filter((t) => t.date <= untilDate);
  }

  // Apply type filter
  if (type === 'inflow') {
    transactions = transactions.filter((t) => t.amount > 0);
  } else if (type === 'outflow') {
    transactions = transactions.filter((t) => t.amount < 0);
  }

  // Apply amount filters
  if (validated.min_amount !== undefined) {
    const minMilliunits = validated.min_amount * 1000;
    transactions = transactions.filter((t) => Math.abs(t.amount) >= minMilliunits);
  }

  if (validated.max_amount !== undefined) {
    const maxMilliunits = validated.max_amount * 1000;
    transactions = transactions.filter((t) => Math.abs(t.amount) <= maxMilliunits);
  }

  // Apply payee filter
  if (validated.payee) {
    const payeeSearch = validated.payee.toLowerCase();
    transactions = transactions.filter(
      (t) => t.payee_name?.toLowerCase().includes(payeeSearch)
    );
  }

  // Apply category filter
  if (validated.category) {
    const categorySearch = validated.category.toLowerCase();
    transactions = transactions.filter((t) => {
      if (!t.category_id) return false;
      const categoryName = categoryLookup.get(t.category_id);
      return categoryName?.toLowerCase().includes(categorySearch);
    });
  }

  // Apply general query search
  if (validated.query) {
    const queryLower = validated.query.toLowerCase();
    transactions = transactions.filter((t) => {
      const payeeMatch = t.payee_name?.toLowerCase().includes(queryLower);
      const memoMatch = t.memo?.toLowerCase().includes(queryLower);
      const categoryName = t.category_id ? categoryLookup.get(t.category_id) : null;
      const categoryMatch = categoryName?.toLowerCase().includes(queryLower);
      return payeeMatch || memoMatch || categoryMatch;
    });
  }

  // Sort by date (most recent first)
  transactions.sort((a, b) => b.date.localeCompare(a.date));

  // Apply limit
  const limitedTransactions = transactions.slice(0, limit);

  // Format results
  const results: SearchResult[] = limitedTransactions.map((t) => ({
    date: t.date,
    payee: sanitizeName(t.payee_name),
    category: t.category_id ? sanitizeName(categoryLookup.get(t.category_id) ?? '') || null : null,
    amount: formatCurrency(t.amount),
    amount_raw: t.amount,
    memo: sanitizeMemo(t.memo),
    account: sanitizeName(accountLookup.get(t.account_id) ?? 'Unknown'),
    cleared: String(t.cleared),
  }));

  // Calculate summary stats
  const totalAmount = sumMilliunits(transactions.map((t) => t.amount));
  const totalOutflow = sumMilliunits(
    transactions.filter((t) => t.amount < 0).map((t) => Math.abs(t.amount))
  );
  const totalInflow = sumMilliunits(
    transactions.filter((t) => t.amount > 0).map((t) => t.amount)
  );

  // Build search description
  const searchCriteria: string[] = [];
  if (validated.query) searchCriteria.push(`text: "${sanitizeName(validated.query)}"`);
  if (validated.payee) searchCriteria.push(`payee: "${sanitizeName(validated.payee)}"`);
  if (validated.category) searchCriteria.push(`category: "${sanitizeName(validated.category)}"`);
  if (validated.min_amount) searchCriteria.push(`min: $${validated.min_amount}`);
  if (validated.max_amount) searchCriteria.push(`max: $${validated.max_amount}`);
  if (sinceDate) searchCriteria.push(`from: ${sinceDate}`);
  if (untilDate) searchCriteria.push(`to: ${untilDate}`);
  if (type !== 'all') searchCriteria.push(`type: ${type}`);

  return JSON.stringify(
    {
      search: {
        criteria: searchCriteria.length > 0 ? searchCriteria.join(', ') : 'all transactions',
        date_range: {
          from: sinceDate ?? 'beginning',
          to: untilDate ?? 'now',
        },
      },
      summary: {
        total_matches: transactions.length,
        showing: results.length,
        total_amount: formatCurrency(totalAmount),
        total_outflow: formatCurrency(totalOutflow),
        total_inflow: formatCurrency(totalInflow),
      },
      transactions: results.map((r) => ({
        date: r.date,
        payee: r.payee,
        category: r.category,
        amount: r.amount,
        memo: r.memo,
        account: r.account,
        cleared: r.cleared,
      })),
      has_more: transactions.length > limit,
    },
    null,
    2
  );
}
