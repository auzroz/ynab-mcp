/**
 * Spending Trends Tool
 *
 * Analyzes multi-month spending trends by category.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
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
    .min(2)
    .max(12)
    .optional()
    .describe('Number of months to analyze (default 6)'),
  category_id: z
    .string()
    .optional()
    .describe('Specific category ID to analyze (optional)'),
});

// Tool definition
export const spendingTrendsTool: Tool = {
  name: 'ynab_spending_trends',
  description: `Analyze spending trends over multiple months.

Use when the user asks:
- "What are my spending trends?"
- "How has my spending changed over time?"
- "Show me category trends"
- "Which categories are increasing?"
- "Am I spending more or less over time?"

Returns month-by-month spending data with trend analysis.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      months: {
        type: 'number',
        description: 'Number of months to analyze (default 6)',
      },
      category_id: {
        type: 'string',
        description: 'Specific category ID to analyze (optional)',
      },
    },
    required: [],
  },
};

interface MonthData {
  month: string;
  spending: number;
  formatted: string;
}

interface CategoryTrend {
  category_name: string;
  group_name: string;
  monthly_data: MonthData[];
  average: string;
  trend: 'increasing' | 'decreasing' | 'stable';
  trend_percent: number;
  total: string;
  total_raw: number;
}

// Handler function
export async function handleSpendingTrends(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const monthCount = validated.months ?? 6;

  // Generate list of months to fetch
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < monthCount; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(date.toISOString().slice(0, 10));
  }
  months.reverse(); // Oldest first

  // Fetch all months and categories in parallel
  const [categoriesResponse, ...monthResponses] = await Promise.all([
    client.getCategories(budgetId),
    ...months.map((m) => client.getBudgetMonth(budgetId, m)),
  ]);

  // Build group lookup
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Build category spending by month
  const categoryData = new Map<
    string,
    { name: string; group: string; months: MonthData[] }
  >();

  for (let i = 0; i < monthResponses.length; i++) {
    const monthData = monthResponses[i]!.data.month;
    const monthStr = months[i]!;

    for (const cat of monthData.categories) {
      const groupName = groupLookup.get(cat.id) ?? 'Other';
      if (groupName === 'Internal Master Category' || cat.hidden) continue;

      // Filter by category if specified
      if (validated.category_id && cat.id !== validated.category_id) continue;

      // Only count outflows (spending)
      const spending = cat.activity < 0 ? Math.abs(cat.activity) : 0;

      if (!categoryData.has(cat.id)) {
        categoryData.set(cat.id, {
          name: sanitizeName(cat.name),
          group: sanitizeName(groupName),
          months: [],
        });
      }

      categoryData.get(cat.id)!.months.push({
        month: monthStr,
        spending,
        formatted: formatCurrency(spending),
      });
    }
  }

  // Calculate trends for each category
  const trends: CategoryTrend[] = [];

  for (const [, data] of categoryData) {
    // Ensure we have data for all months
    if (data.months.length < 2) continue;

    const total = data.months.reduce((sum, m) => sum + m.spending, 0);
    const average = total / data.months.length;

    // Skip categories with no spending
    if (total === 0) continue;

    // Calculate trend using simple linear regression
    const n = data.months.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 0; i < n; i++) {
      const x = i;
      const y = data.months[i]!.spending;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    // Guard against division by zero in linear regression
    const denominator = n * sumX2 - sumX * sumX;
    const slope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;

    // Calculate trend percentage (slope as % of average)
    const trendPercent = average > 0 ? (slope / average) * 100 : 0;

    let trend: 'increasing' | 'decreasing' | 'stable';
    if (trendPercent > 10) {
      trend = 'increasing';
    } else if (trendPercent < -10) {
      trend = 'decreasing';
    } else {
      trend = 'stable';
    }

    trends.push({
      category_name: data.name,
      group_name: data.group,
      monthly_data: data.months,
      average: formatCurrency(average),
      trend,
      trend_percent: Math.round(trendPercent),
      total: formatCurrency(total),
      total_raw: total,
    });
  }

  // Sort by total spending (highest first) using raw value
  trends.sort((a, b) => b.total_raw - a.total_raw);

  // Calculate overall trends
  const increasing = trends.filter((t) => t.trend === 'increasing');
  const decreasing = trends.filter((t) => t.trend === 'decreasing');
  const stable = trends.filter((t) => t.trend === 'stable');

  // Calculate total spending by month
  const monthlyTotals = months.map((month) => {
    let total = 0;
    for (const [, data] of categoryData) {
      const monthData = data.months.find((m) => m.month === month);
      if (monthData) total += monthData.spending;
    }
    return {
      month,
      total: formatCurrency(total),
      total_raw: total,
    };
  });

  // Determine overall spending trend
  const firstHalf = monthlyTotals.slice(0, Math.floor(monthlyTotals.length / 2));
  const secondHalf = monthlyTotals.slice(Math.floor(monthlyTotals.length / 2));
  const firstHalfAvg =
    firstHalf.reduce((sum, m) => sum + m.total_raw, 0) / firstHalf.length;
  const secondHalfAvg =
    secondHalf.reduce((sum, m) => sum + m.total_raw, 0) / secondHalf.length;
  const overallChange =
    firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;

  let overallTrend: 'increasing' | 'decreasing' | 'stable';
  let overallMessage: string;

  if (overallChange > 10) {
    overallTrend = 'increasing';
    overallMessage = `Overall spending is up ${Math.round(overallChange)}% in recent months`;
  } else if (overallChange < -10) {
    overallTrend = 'decreasing';
    overallMessage = `Overall spending is down ${Math.abs(Math.round(overallChange))}% in recent months`;
  } else {
    overallTrend = 'stable';
    overallMessage = 'Overall spending has been relatively stable';
  }

  return JSON.stringify(
    {
      period: {
        months_analyzed: monthCount,
        date_range: `${months[0]} to ${months[months.length - 1]}`,
      },
      overall: {
        trend: overallTrend,
        message: overallMessage,
        change_percent: Math.round(overallChange),
      },
      monthly_totals: monthlyTotals.map((m) => ({
        month: m.month,
        total: m.total,
      })),
      summary: {
        categories_analyzed: trends.length,
        increasing: increasing.length,
        decreasing: decreasing.length,
        stable: stable.length,
      },
      notable_increases: increasing.slice(0, 5).map((t) => ({
        category: t.category_name,
        group: t.group_name,
        average: t.average,
        trend_percent: `+${t.trend_percent}%`,
      })),
      notable_decreases: decreasing.slice(0, 5).map((t) => ({
        category: t.category_name,
        group: t.group_name,
        average: t.average,
        trend_percent: `${t.trend_percent}%`,
      })),
      all_trends: validated.category_id
        ? trends
        : trends.slice(0, 15).map((t) => ({
            category: t.category_name,
            group: t.group_name,
            monthly_spending: t.monthly_data.map((m) => ({
              month: m.month,
              amount: m.formatted,
            })),
            average: t.average,
            trend: t.trend,
            trend_percent: `${t.trend_percent > 0 ? '+' : ''}${t.trend_percent}%`,
          })),
    },
    null,
    2
  );
}
