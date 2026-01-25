/**
 * Budget Suggestions Tool
 *
 * Suggests budget amounts based on historical spending patterns.
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
    .describe('Number of months of history to analyze (default 3)'),
});

// Tool definition
export const budgetSuggestionsTool: Tool = {
  name: 'ynab_budget_suggestions',
  description: `Suggest budget amounts based on historical spending.

Use when the user asks:
- "How much should I budget for [category]?"
- "Suggest budget amounts"
- "What's a realistic budget?"
- "Help me set my budget"
- "Based on my spending, what should I budget?"

Returns suggested monthly budget amounts for each category based on actual spending patterns.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      months: {
        type: 'number',
        description: 'Number of months of history to analyze (default 3)',
      },
    },
    required: [],
  },
};

interface CategorySuggestion {
  category_name: string;
  group_name: string;
  current_budget: number;
  suggested_budget: number;
  average_spending: number;
  max_spending: number;
  min_spending: number;
  recommendation: 'increase' | 'decrease' | 'maintain';
  confidence: 'high' | 'medium' | 'low';
}

// Handler function
/**
 * Handler for the ynab_budget_suggestions tool.
 */
export async function handleBudgetSuggestions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const monthCount = validated.months ?? 3;

  // Generate list of months to analyze (excluding current month)
  // Use UTC methods to avoid timezone drift when converting to ISO strings
  const months: string[] = [];
  const now = new Date();
  for (let i = 1; i <= monthCount; i++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}-01`);
  }

  // Get current month for current budget values (use UTC for consistency)
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

  // Fetch all data in parallel
  // Note: For new budgets with insufficient history, some month fetches may fail.
  // We use Promise.allSettled for historical months to gracefully handle this,
  // allowing the tool to work with whatever history is available.
  const [categoriesResponse, currentMonthResponse, ...historicalMonthResults] =
    await Promise.all([
      client.getCategories(budgetId),
      client.getBudgetMonth(budgetId, currentMonth),
      ...months.map((m) =>
        client.getBudgetMonth(budgetId, m).then(
          (response) => ({ status: 'fulfilled' as const, value: response }),
          (error) => ({ status: 'rejected' as const, reason: error })
        )
      ),
    ]);

  // Filter to only successful month fetches
  const historicalMonthResponses = historicalMonthResults
    .filter((result): result is { status: 'fulfilled'; value: Awaited<ReturnType<typeof client.getBudgetMonth>> } =>
      result.status === 'fulfilled'
    )
    .map((result) => result.value);

  // If no historical data available, return early with helpful message
  if (historicalMonthResponses.length === 0) {
    return JSON.stringify(
      {
        error: false,
        message: 'Insufficient budget history for suggestions. This tool requires at least one month of historical data.',
        analysis_period: {
          months_requested: monthCount,
          months_available: 0,
        },
        tips: [
          'Budget suggestions require historical spending data',
          'Try again after using YNAB for at least one full month',
          'You can also manually review your spending patterns in YNAB',
        ],
      },
      null,
      2
    );
  }

  // Build group lookup
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Build current budget lookup
  const currentBudgetLookup = new Map<string, number>();
  for (const cat of currentMonthResponse.data.month.categories) {
    currentBudgetLookup.set(cat.id, cat.budgeted);
  }

  // Collect spending data by category
  const spendingData = new Map<
    string,
    { name: string; group: string; spending: number[] }
  >();

  for (const monthResponse of historicalMonthResponses) {
    for (const cat of monthResponse.data.month.categories) {
      const groupName = groupLookup.get(cat.id) ?? 'Other';
      if (groupName === 'Internal Master Category' || cat.hidden) continue;

      // Only count outflows (spending)
      const spending = cat.activity < 0 ? Math.abs(cat.activity) : 0;

      if (!spendingData.has(cat.id)) {
        spendingData.set(cat.id, {
          name: cat.name,
          group: groupName,
          spending: [],
        });
      }

      spendingData.get(cat.id)!.spending.push(spending);
    }
  }

  // Calculate suggestions
  const suggestions: CategorySuggestion[] = [];

  for (const [catId, data] of spendingData) {
    // Skip categories with no spending history
    if (data.spending.length === 0) continue;

    const avgSpending = sumMilliunits(data.spending) / data.spending.length;
    const maxSpending = Math.max(...data.spending);
    const minSpending = Math.min(...data.spending);
    const currentBudget = currentBudgetLookup.get(catId) ?? 0;

    // Skip categories with no activity
    if (avgSpending === 0 && currentBudget === 0) continue;

    // Calculate suggested budget:
    // - Add 10% buffer to average spending for cushion
    // - Round up to nearest $5 (5000 milliunits) for clean budget amounts
    const BUFFER_MULTIPLIER = 1.1; // 10% buffer
    const ROUND_TO_MILLIS = 5000; // $5.00 in milliunits (1000 milliunits = $1)
    const suggestedRaw = avgSpending * BUFFER_MULTIPLIER;
    const suggestedBudget = Math.ceil(suggestedRaw / ROUND_TO_MILLIS) * ROUND_TO_MILLIS;

    // Determine recommendation
    let recommendation: 'increase' | 'decrease' | 'maintain';
    const difference = suggestedBudget - currentBudget;
    const percentDiff = currentBudget > 0 ? (difference / currentBudget) * 100 : 100;

    if (percentDiff > 15) {
      recommendation = 'increase';
    } else if (percentDiff < -15) {
      recommendation = 'decrease';
    } else {
      recommendation = 'maintain';
    }

    // Determine confidence based on spending consistency
    const range = maxSpending - minSpending;
    const rangePercent = avgSpending > 0 ? (range / avgSpending) * 100 : 0;

    let confidence: 'high' | 'medium' | 'low';
    if (data.spending.length >= 3 && rangePercent < 30) {
      confidence = 'high';
    } else if (data.spending.length >= 2 && rangePercent < 60) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    suggestions.push({
      category_name: sanitizeName(data.name),
      group_name: sanitizeName(data.group),
      current_budget: currentBudget,
      suggested_budget: suggestedBudget,
      average_spending: avgSpending,
      max_spending: maxSpending,
      min_spending: minSpending,
      recommendation,
      confidence,
    });
  }

  // Sort by difference (biggest gaps first)
  suggestions.sort((a, b) => {
    const aDiff = Math.abs(a.suggested_budget - a.current_budget);
    const bDiff = Math.abs(b.suggested_budget - b.current_budget);
    return bDiff - aDiff;
  });

  // Group by recommendation
  const needsIncrease = suggestions.filter((s) => s.recommendation === 'increase');
  const canDecrease = suggestions.filter((s) => s.recommendation === 'decrease');
  const onTarget = suggestions.filter((s) => s.recommendation === 'maintain');

  // Calculate total adjustments
  const totalIncrease = sumMilliunits(
    needsIncrease.map((s) => s.suggested_budget - s.current_budget)
  );
  const totalDecrease = sumMilliunits(
    canDecrease.map((s) => s.current_budget - s.suggested_budget)
  );

  return JSON.stringify(
    {
      analysis_period: {
        months_requested: monthCount,
        months_available: historicalMonthResponses.length,
        months: months.slice(0, historicalMonthResponses.length),
      },
      summary: {
        categories_analyzed: suggestions.length,
        needs_increase: needsIncrease.length,
        can_decrease: canDecrease.length,
        on_target: onTarget.length,
        net_adjustment_needed: formatCurrency(totalIncrease - totalDecrease),
      },
      needs_increase: needsIncrease.slice(0, 10).map((s) => ({
        category: s.category_name,
        group: s.group_name,
        current: formatCurrency(s.current_budget),
        suggested: formatCurrency(s.suggested_budget),
        average_spending: formatCurrency(s.average_spending),
        increase_by: formatCurrency(s.suggested_budget - s.current_budget),
        confidence: s.confidence,
      })),
      can_decrease: canDecrease.slice(0, 10).map((s) => ({
        category: s.category_name,
        group: s.group_name,
        current: formatCurrency(s.current_budget),
        suggested: formatCurrency(s.suggested_budget),
        average_spending: formatCurrency(s.average_spending),
        decrease_by: formatCurrency(s.current_budget - s.suggested_budget),
        confidence: s.confidence,
      })),
      on_target: onTarget.slice(0, 5).map((s) => ({
        category: s.category_name,
        group: s.group_name,
        current: formatCurrency(s.current_budget),
        average_spending: formatCurrency(s.average_spending),
      })),
      tips: [
        'Suggestions include a 10% buffer above average spending',
        'High confidence means consistent spending patterns',
        'Review low confidence suggestions more carefully',
        'Consider seasonal variations not captured in recent months',
      ],
    },
    null,
    2
  );
}
