/**
 * Spending Analysis Tool
 *
 * Analyzes spending patterns across categories and time periods.
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
  category_id: z.string().optional().describe('Optional: Focus on a specific category'),
});

// Tool definition
export const spendingAnalysisTool: Tool = {
  name: 'ynab_spending_analysis',
  description: `Analyze spending patterns and trends.

Use when the user asks:
- "How much am I spending?"
- "What are my biggest expenses?"
- "Show my spending trends"
- "Analyze my spending habits"
- "Where does my money go?"

Provides category breakdowns, trends, and insights.`,
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
      category_id: {
        type: 'string',
        description: 'Optional: Focus on a specific category',
      },
    },
    required: [],
  },
};

interface CategorySpending {
  category_name: string;
  group_name: string;
  total_spent: string;
  transaction_count: number;
  average_per_transaction: string;
  percent_of_total: number;
  monthly_average: string;
  trend: 'increasing' | 'decreasing' | 'stable';
  trend_percent: number | null;
}

interface MonthlySpending {
  month: string;
  total_spent: string;
  category_breakdown: { name: string; amount: string }[];
}

// Handler function
export async function handleSpendingAnalysis(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const months = validated.months ?? 3;

  // Calculate since_date
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - months);
  const sinceDateStr = sinceDate.toISOString().split('T')[0] ?? '';
  const options: { sinceDate: string } = { sinceDate: sinceDateStr };

  // Get transactions and categories
  const [transactionsResponse, categoriesResponse] = await Promise.all([
    client.getTransactions(budgetId, options),
    client.getCategories(budgetId),
  ]);

  // Build category lookup
  const categoryLookup = new Map<string, { name: string; group: string }>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      categoryLookup.set(cat.id, { name: sanitizeName(cat.name), group: sanitizeName(group.name) });
    }
  }

  // Filter to outflows only (negative amounts)
  let transactions = transactionsResponse.data.transactions.filter(
    (t) => t.amount < 0 && !t.deleted && !t.transfer_account_id
  );

  // Filter by category if specified
  if (validated.category_id) {
    transactions = transactions.filter((t) => t.category_id === validated.category_id);
  }

  // Group by category
  const byCategoryRaw = new Map<
    string,
    {
      amounts: number[];
      byMonth: Map<string, number[]>;
    }
  >();

  for (const txn of transactions) {
    const categoryId = txn.category_id ?? 'uncategorized';
    const month = txn.date.substring(0, 7); // YYYY-MM

    if (!byCategoryRaw.has(categoryId)) {
      byCategoryRaw.set(categoryId, { amounts: [], byMonth: new Map() });
    }

    const catData = byCategoryRaw.get(categoryId)!;
    catData.amounts.push(Math.abs(txn.amount));

    if (!catData.byMonth.has(month)) {
      catData.byMonth.set(month, []);
    }
    catData.byMonth.get(month)!.push(Math.abs(txn.amount));
  }

  // Calculate total spending
  const totalSpending = sumMilliunits(transactions.map((t) => Math.abs(t.amount)));

  // Build category analysis
  const categorySpending: CategorySpending[] = [];

  for (const [categoryId, data] of byCategoryRaw) {
    const lookup = categoryLookup.get(categoryId) ?? { name: sanitizeName('Uncategorized'), group: sanitizeName('Other') };
    const total = sumMilliunits(data.amounts);
    const percentOfTotal = totalSpending > 0 ? (total / totalSpending) * 100 : 0;

    // Calculate monthly totals for trend
    const monthlyTotals: { month: string; total: number }[] = [];
    for (const [month, amounts] of data.byMonth) {
      monthlyTotals.push({ month, total: sumMilliunits(amounts) });
    }
    monthlyTotals.sort((a, b) => a.month.localeCompare(b.month));

    // Calculate trend
    const { trend, trendPercent } = calculateTrend(monthlyTotals);

    categorySpending.push({
      category_name: lookup.name,
      group_name: lookup.group,
      total_spent: formatCurrency(total),
      transaction_count: data.amounts.length,
      average_per_transaction: formatCurrency(data.amounts.length > 0 ? total / data.amounts.length : 0),
      percent_of_total: Math.round(percentOfTotal * 10) / 10,
      monthly_average: formatCurrency(months > 0 ? total / months : 0),
      trend,
      trend_percent: trendPercent,
    });
  }

  // Sort by total spent (highest first)
  categorySpending.sort((a, b) => {
    const amountA = parseFloat(a.total_spent.replace(/[^0-9.-]/g, ''));
    const amountB = parseFloat(b.total_spent.replace(/[^0-9.-]/g, ''));
    return amountB - amountA;
  });

  // Group by month
  const byMonth = new Map<string, Map<string, number>>();
  for (const txn of transactions) {
    const month = txn.date.substring(0, 7);
    const categoryId = txn.category_id ?? 'uncategorized';

    if (!byMonth.has(month)) {
      byMonth.set(month, new Map());
    }

    const monthData = byMonth.get(month)!;
    monthData.set(categoryId, (monthData.get(categoryId) ?? 0) + Math.abs(txn.amount));
  }

  // Build monthly spending data
  const monthlySpending: MonthlySpending[] = [];
  for (const [month, categories] of byMonth) {
    const total = sumMilliunits(Array.from(categories.values()));
    const breakdown: { name: string; amount: string }[] = [];

    for (const [catId, amount] of categories) {
      const lookup = categoryLookup.get(catId) ?? { name: sanitizeName('Uncategorized'), group: sanitizeName('Other') };
      breakdown.push({ name: lookup.name, amount: formatCurrency(amount) });
    }

    breakdown.sort((a, b) => {
      const amountA = parseFloat(a.amount.replace(/[^0-9.-]/g, ''));
      const amountB = parseFloat(b.amount.replace(/[^0-9.-]/g, ''));
      return amountB - amountA;
    });

    monthlySpending.push({
      month,
      total_spent: formatCurrency(total),
      category_breakdown: breakdown.slice(0, 5), // Top 5 categories
    });
  }

  monthlySpending.sort((a, b) => a.month.localeCompare(b.month));

  // Calculate insights
  const dailyAverage = totalSpending / (months * 30);
  const topCategories = categorySpending.slice(0, 5);
  const increasingCategories = categorySpending.filter((c) => c.trend === 'increasing');
  const decreasingCategories = categorySpending.filter((c) => c.trend === 'decreasing');

  return JSON.stringify(
    {
      spending_by_category: categorySpending,
      monthly_spending: monthlySpending,
      summary: {
        total_spent: formatCurrency(totalSpending),
        monthly_average: formatCurrency(months > 0 ? totalSpending / months : 0),
        daily_average: formatCurrency(dailyAverage),
        transaction_count: transactions.length,
        category_count: categorySpending.length,
        analysis_period: `${months} months`,
        since_date: sinceDateStr,
      },
      insights: {
        top_5_categories: topCategories.map((c) => ({
          name: c.category_name,
          amount: c.total_spent,
          percent: c.percent_of_total,
        })),
        increasing_spending: increasingCategories.slice(0, 3).map((c) => ({
          name: c.category_name,
          trend_percent: c.trend_percent,
        })),
        decreasing_spending: decreasingCategories.slice(0, 3).map((c) => ({
          name: c.category_name,
          trend_percent: c.trend_percent,
        })),
      },
    },
    null,
    2
  );
}

function calculateTrend(
  monthlyTotals: { month: string; total: number }[]
): { trend: CategorySpending['trend']; trendPercent: number | null } {
  if (monthlyTotals.length < 2) {
    return { trend: 'stable', trendPercent: null };
  }

  // Compare first half to second half
  const midpoint = Math.floor(monthlyTotals.length / 2);
  const firstHalf = monthlyTotals.slice(0, midpoint);
  const secondHalf = monthlyTotals.slice(midpoint);

  const firstAvg =
    firstHalf.reduce((sum, m) => sum + m.total, 0) / (firstHalf.length || 1);
  const secondAvg =
    secondHalf.reduce((sum, m) => sum + m.total, 0) / (secondHalf.length || 1);

  if (firstAvg === 0) {
    return { trend: secondAvg > 0 ? 'increasing' : 'stable', trendPercent: null };
  }

  const percentChange = ((secondAvg - firstAvg) / firstAvg) * 100;

  if (percentChange > 10) {
    return { trend: 'increasing', trendPercent: Math.round(percentChange) };
  } else if (percentChange < -10) {
    return { trend: 'decreasing', trendPercent: Math.round(percentChange) };
  } else {
    return { trend: 'stable', trendPercent: Math.round(percentChange) };
  }
}
