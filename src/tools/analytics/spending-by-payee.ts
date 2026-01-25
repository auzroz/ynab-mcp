/**
 * Spending by Payee Tool
 *
 * Analyzes spending patterns by merchant/payee.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  months: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe('Number of months to analyze (default 3)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of payees to return (default 20)'),
  min_transactions: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Minimum transactions to include payee (default 1)'),
});

// Tool definition
export const spendingByPayeeTool: Tool = {
  name: 'ynab_spending_by_payee',
  description: `Analyze spending patterns by merchant/payee.

Use when the user asks:
- "Where do I spend the most?"
- "Top merchants by spending"
- "Which stores do I shop at most?"
- "Show spending by payee"
- "Who gets most of my money?"

Returns top payees ranked by total spending with transaction counts and averages.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      months: {
        type: 'number',
        description: 'Number of months to analyze (default 3)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of payees to return (default 20)',
      },
      min_transactions: {
        type: 'number',
        description: 'Minimum transactions to include payee (default 1)',
      },
    },
    required: [],
  },
};

interface PayeeSpending {
  payee_name: string;
  total_spent: string;
  total_spent_raw: number;
  transaction_count: number;
  average_transaction: string;
  percent_of_total: number;
  most_common_category: string | null;
  first_transaction: string;
  last_transaction: string;
}

// Handler function
/**
 * Handler for the ynab_spending_by_payee tool.
 */
export async function handleSpendingByPayee(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const months = validated.months ?? 3;
  const limit = validated.limit ?? 20;
  const minTransactions = validated.min_transactions ?? 1;

  // Calculate since date (set day to 1 to avoid month overflow, e.g., Mar 31 - 1 month = Feb 31 = Mar 3)
  const sinceDate = new Date();
  sinceDate.setDate(1);
  sinceDate.setMonth(sinceDate.getMonth() - months);
  const sinceDateStr = sinceDate.toISOString().split('T')[0] ?? '';

  // Get transactions
  const transactionsResponse = await client.getTransactions(budgetId, {
    sinceDate: sinceDateStr,
  });

  // Filter to outflows only (negative amounts), excluding transfers
  const transactions = transactionsResponse.data.transactions.filter(
    (t) => t.amount < 0 && !t.deleted && !t.transfer_account_id
  );

  // Calculate total spending
  const totalSpending = sumMilliunits(transactions.map((t) => Math.abs(t.amount)));

  // Group by payee
  const byPayee = new Map<
    string,
    {
      amounts: number[];
      categories: string[];
      dates: string[];
    }
  >();

  for (const txn of transactions) {
    const payeeName = sanitizeName(txn.payee_name);

    if (!byPayee.has(payeeName)) {
      byPayee.set(payeeName, {
        amounts: [],
        categories: [],
        dates: [],
      });
    }

    const payeeData = byPayee.get(payeeName)!;
    payeeData.amounts.push(Math.abs(txn.amount));
    if (txn.category_name) {
      payeeData.categories.push(sanitizeName(txn.category_name));
    }
    payeeData.dates.push(txn.date);
  }

  // Build payee spending list
  const payeeSpending: PayeeSpending[] = [];

  for (const [payeeName, data] of byPayee) {
    // Skip if below minimum transactions
    if (data.amounts.length < minTransactions) {
      continue;
    }

    const totalSpent = sumMilliunits(data.amounts);
    const avgTransaction = totalSpent / data.amounts.length;
    const percentOfTotal = totalSpending > 0 ? (totalSpent / totalSpending) * 100 : 0;

    // Find most common category
    const categoryCounts = new Map<string, number>();
    for (const cat of data.categories) {
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
    let mostCommonCategory: string | null = null;
    let maxCount = 0;
    for (const [cat, count] of categoryCounts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonCategory = cat;
      }
    }

    // Sort dates
    const sortedDates = data.dates.sort();
    const firstDate = sortedDates[0] ?? '';
    const lastDate = sortedDates[sortedDates.length - 1] ?? '';

    payeeSpending.push({
      payee_name: payeeName,
      total_spent: formatCurrency(totalSpent),
      total_spent_raw: totalSpent,
      transaction_count: data.amounts.length,
      average_transaction: formatCurrency(avgTransaction),
      percent_of_total: Math.round(percentOfTotal * 10) / 10,
      most_common_category: mostCommonCategory,
      first_transaction: firstDate,
      last_transaction: lastDate,
    });
  }

  // Sort by total spent (highest first)
  payeeSpending.sort((a, b) => b.total_spent_raw - a.total_spent_raw);

  // Apply limit
  const topPayees = payeeSpending.slice(0, limit);

  // Calculate stats
  const top5Total = sumMilliunits(topPayees.slice(0, 5).map((p) => p.total_spent_raw));
  const top5Percent = totalSpending > 0 ? (top5Total / totalSpending) * 100 : 0;

  return JSON.stringify(
    {
      period: {
        months_analyzed: months,
        since_date: sinceDateStr,
      },
      summary: {
        total_spending: formatCurrency(totalSpending),
        unique_payees: byPayee.size,
        payees_shown: topPayees.length,
        top_5_concentration: `${Math.round(top5Percent)}%`,
        transaction_count: transactions.length,
      },
      top_payees: topPayees.map((p) => ({
        payee: p.payee_name,
        total: p.total_spent,
        transactions: p.transaction_count,
        average: p.average_transaction,
        percent: `${p.percent_of_total}%`,
        category: p.most_common_category,
        last_transaction: p.last_transaction,
      })),
      insights: {
        highest_spender: topPayees[0]?.payee_name ?? null,
        most_frequent: payeeSpending.length > 0
          ? payeeSpending.reduce((max, p) =>
              p.transaction_count > max.transaction_count ? p : max
            ).payee_name
          : null,
        highest_average: (() => {
          const qualified = payeeSpending.filter((p) => p.transaction_count >= 3);
          if (qualified.length === 0) return null;
          return qualified.reduce(
            (max, p) =>
              p.total_spent_raw / p.transaction_count >
              max.total_spent_raw / max.transaction_count
                ? p
                : max
          ).payee_name;
        })(),
      },
    },
    null,
    2
  );
}
