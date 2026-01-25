/**
 * Savings Opportunities Tool
 *
 * Identifies potential areas where the user could save money.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import DecimalJS from 'decimal.js';

const Decimal = DecimalJS.default ?? DecimalJS;

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
    .describe('Number of months to analyze (default 3)'),
});

// Tool definition
export const savingsOpportunitiesTool: Tool = {
  name: 'ynab_savings_opportunities',
  description: `Find potential savings opportunities based on spending patterns.

Use when the user asks:
- "How can I save money?"
- "Where can I cut back?"
- "What are my unnecessary expenses?"
- "Help me reduce spending"
- "Find savings opportunities"

Analyzes spending to identify areas where cuts might be possible.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      months: {
        type: 'number',
        description: 'Number of months to analyze (2-12, default 3)',
        minimum: 2,
        maximum: 12,
      },
    },
    required: [],
  },
};

interface SavingsOpportunity {
  type:
    | 'recurring_expense'
    | 'high_variance'
    | 'discretionary'
    | 'underused_subscription'
    | 'large_single';
  category: string;
  description: string;
  potential_monthly_savings: string;
  potential_monthly_savings_milliunits: number;
  current_monthly_spend: string;
  current_monthly_spend_milliunits: number;
  suggestion: string;
  confidence: 'high' | 'medium' | 'low';
}

// Discretionary categories (common ones that can often be reduced)
const DISCRETIONARY_CATEGORIES = [
  'dining',
  'restaurant',
  'eating out',
  'entertainment',
  'streaming',
  'subscriptions',
  'shopping',
  'clothes',
  'clothing',
  'coffee',
  'alcohol',
  'bars',
  'hobbies',
  'games',
  'personal care',
  'gifts',
];

// Handler function
/**
 * Handler for the ynab_savings_opportunities tool.
 */
export async function handleSavingsOpportunities(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const months = validated.months ?? 3;

  // Calculate since_date - pin to day 1 to avoid month overflow on 29th-31st
  const sinceDate = new Date();
  sinceDate.setDate(1); // Pin to first of month before subtracting
  sinceDate.setMonth(sinceDate.getMonth() - months);
  const sinceDateStr = sinceDate.toISOString().split('T')[0] ?? '';
  const options: { sinceDate: string } = { sinceDate: sinceDateStr };

  // Get data
  const [transactionsResponse, categoriesResponse] = await Promise.all([
    client.getTransactions(budgetId, options),
    client.getCategories(budgetId),
  ]);

  // Build category lookup
  const categoryLookup = new Map<
    string,
    { name: string; group: string; isDiscretionary: boolean }
  >();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      const lowerName = cat.name.toLowerCase();
      const lowerGroup = group.name.toLowerCase();
      const isDiscretionary = DISCRETIONARY_CATEGORIES.some(
        (d) => lowerName.includes(d) || lowerGroup.includes(d)
      );
      categoryLookup.set(cat.id, {
        name: cat.name,
        group: group.name,
        isDiscretionary,
      });
    }
  }

  // Filter outflows
  const transactions = transactionsResponse.data.transactions.filter(
    (t) => t.amount < 0 && !t.deleted && !t.transfer_account_id
  );

  const opportunities: SavingsOpportunity[] = [];

  // Group by category and payee
  const byCategory = new Map<
    string,
    {
      amounts: number[];
      byMonth: Map<string, number[]>;
      byPayee: Map<string, number[]>;
    }
  >();

  for (const txn of transactions) {
    const categoryId = txn.category_id ?? 'uncategorized';
    const month = txn.date.substring(0, 7);
    const payeeId = txn.payee_id ?? 'unknown';

    if (!byCategory.has(categoryId)) {
      byCategory.set(categoryId, {
        amounts: [],
        byMonth: new Map(),
        byPayee: new Map(),
      });
    }

    const catData = byCategory.get(categoryId)!;
    catData.amounts.push(Math.abs(txn.amount));

    if (!catData.byMonth.has(month)) {
      catData.byMonth.set(month, []);
    }
    catData.byMonth.get(month)!.push(Math.abs(txn.amount));

    if (!catData.byPayee.has(payeeId)) {
      catData.byPayee.set(payeeId, []);
    }
    catData.byPayee.get(payeeId)!.push(Math.abs(txn.amount));
  }

  // Analyze each category
  for (const [categoryId, data] of byCategory) {
    const lookup = categoryLookup.get(categoryId) ?? {
      name: 'Uncategorized',
      group: 'Other',
      isDiscretionary: false,
    };
    const safeCategory = sanitizeName(lookup.name);

    const total = sumMilliunits(data.amounts);
    const monthlyAvg = total / months;

    // 1. High discretionary spending
    if (lookup.isDiscretionary && monthlyAvg > 5000) {
      // More than $50/month
      const potentialSavings = Math.round(monthlyAvg * 0.2); // Suggest 20% reduction
      opportunities.push({
        type: 'discretionary',
        category: safeCategory,
        description: `Discretionary spending on ${safeCategory}`,
        potential_monthly_savings: formatCurrency(potentialSavings),
        potential_monthly_savings_milliunits: potentialSavings,
        current_monthly_spend: formatCurrency(monthlyAvg),
        current_monthly_spend_milliunits: Math.round(monthlyAvg),
        suggestion: `Consider reducing ${safeCategory} spending by 20%`,
        confidence: 'medium',
      });
    }

    // 2. High variance - inconsistent spending might have waste
    const monthlyTotals = Array.from(data.byMonth.values()).map((amounts) =>
      sumMilliunits(amounts)
    );
    if (monthlyTotals.length >= 2) {
      const avgMonthly =
        monthlyTotals.reduce((a, b) => a + b, 0) / monthlyTotals.length;
      const maxMonthly = Math.max(...monthlyTotals);
      const variance = maxMonthly - avgMonthly;

      if (variance > avgMonthly * 0.5 && avgMonthly > 10000) {
        // High variance and significant spend
        const potentialSavings = Math.round(variance * 0.3); // Could save 30% of variance
        opportunities.push({
          type: 'high_variance',
          category: safeCategory,
          description: `Inconsistent spending on ${safeCategory} - some months much higher`,
          potential_monthly_savings: formatCurrency(potentialSavings),
          potential_monthly_savings_milliunits: potentialSavings,
          current_monthly_spend: formatCurrency(avgMonthly),
          current_monthly_spend_milliunits: Math.round(avgMonthly),
          suggestion: `Your ${safeCategory} spending varies significantly. Setting a fixed budget could help.`,
          confidence: 'low',
        });
      }
    }

    // 3. Look for recurring small expenses (potential subscriptions)
    for (const [payeeId, payeeAmounts] of data.byPayee) {
      if (payeeAmounts.length >= 2) {
        // Check if amounts are consistent (subscription-like)
        const avg = new Decimal(sumMilliunits(payeeAmounts))
          .dividedBy(payeeAmounts.length)
          .toNumber();
        const allSimilar = payeeAmounts.every(
          (a) => Math.abs(a - avg) < avg * 0.1 // Within 10% of average
        );

        const firstAmount = payeeAmounts[0];
        if (allSimilar && avg > 500 && avg < 50000 && firstAmount !== undefined) {
          // $5-$500 range (likely subscription)
          // Find the payee name using the specific payeeId
          const txn = transactions.find(
            (t) =>
              t.category_id === categoryId &&
              (t.payee_id ?? 'unknown') === payeeId
          );
          const payeeName = sanitizeName(txn?.payee_name ?? 'Unknown');
          const avgRounded = Math.round(avg);

          opportunities.push({
            type: 'recurring_expense',
            category: safeCategory,
            description: `Recurring charge: ${payeeName}`,
            potential_monthly_savings: formatCurrency(avgRounded),
            potential_monthly_savings_milliunits: avgRounded,
            current_monthly_spend: formatCurrency(avgRounded),
            current_monthly_spend_milliunits: avgRounded,
            suggestion: `Review if you still need ${payeeName}. Cancel if unused.`,
            confidence: 'high',
          });
        }
      }
    }

    // 4. Large single transactions
    const largeTransactions = data.amounts.filter((a) => a > 100000); // Over $100
    if (largeTransactions.length > 0) {
      const monthlyImpact = sumMilliunits(largeTransactions) / months;

      if (monthlyImpact > 20000 && lookup.isDiscretionary) {
        const potentialSavings = Math.round(monthlyImpact * 0.3);
        opportunities.push({
          type: 'large_single',
          category: safeCategory,
          description: `Large purchases in ${safeCategory}`,
          potential_monthly_savings: formatCurrency(potentialSavings),
          potential_monthly_savings_milliunits: potentialSavings,
          current_monthly_spend: formatCurrency(monthlyImpact),
          current_monthly_spend_milliunits: Math.round(monthlyImpact),
          suggestion: `Review large ${safeCategory} purchases. Consider waiting periods before big buys.`,
          confidence: 'low',
        });
      }
    }
  }

  // Deduplicate and sort by potential savings
  const seen = new Set<string>();
  const deduped = opportunities.filter((o) => {
    const key = `${o.type}-${o.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by potential savings using raw milliunits for accurate numeric sorting
  deduped.sort((a, b) => {
    return b.potential_monthly_savings_milliunits - a.potential_monthly_savings_milliunits;
  });

  // Calculate totals using raw milliunits for accuracy
  const totalPotentialSavingsMilliunits = deduped.reduce((sum, o) => {
    return sum + o.potential_monthly_savings_milliunits;
  }, 0);

  const totalCurrentSpend = sumMilliunits(transactions.map((t) => Math.abs(t.amount))) / months;

  const highConfidenceOpportunities = deduped.filter((o) => o.confidence === 'high');
  const highConfidenceSavingsMilliunits = highConfidenceOpportunities.reduce((sum, o) => {
    return sum + o.potential_monthly_savings_milliunits;
  }, 0);

  return JSON.stringify(
    {
      opportunities: deduped.slice(0, 15), // Top 15 opportunities
      summary: {
        total_opportunities_found: deduped.length,
        total_potential_monthly_savings: formatCurrency(totalPotentialSavingsMilliunits),
        total_potential_monthly_savings_milliunits: totalPotentialSavingsMilliunits,
        high_confidence_savings: formatCurrency(highConfidenceSavingsMilliunits),
        high_confidence_savings_milliunits: highConfidenceSavingsMilliunits,
        current_monthly_spend: formatCurrency(totalCurrentSpend),
        current_monthly_spend_milliunits: Math.round(totalCurrentSpend),
        potential_savings_percent:
          totalCurrentSpend > 0
            ? Math.round((totalPotentialSavingsMilliunits / totalCurrentSpend) * 100)
            : 0,
        analysis_period: `${months} months`,
      },
      quick_wins: highConfidenceOpportunities.slice(0, 5).map((o) => ({
        category: o.category,
        description: o.description,
        potential_savings: o.potential_monthly_savings,
        potential_savings_milliunits: o.potential_monthly_savings_milliunits,
        action: o.suggestion,
      })),
    },
    null,
    2
  );
}
