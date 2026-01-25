/**
 * Unused Categories Tool
 *
 * Identifies categories with no activity that could be cleaned up.
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
    .min(1)
    .max(12)
    .optional()
    .describe('Number of months to check for activity (default 6)'),
  include_funded: z
    .boolean()
    .optional()
    .describe('Include categories that have funds but no spending (default false)'),
});

// Tool definition
export const unusedCategoriesTool: Tool = {
  name: 'ynab_unused_categories',
  description: `Find categories with no recent activity.

Use when the user asks:
- "Which categories am I not using?"
- "Find unused categories"
- "Clean up my budget categories"
- "Categories with no activity"
- "What categories can I delete?"

Helps identify categories that could be removed or consolidated.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      months: {
        type: 'number',
        description: 'Number of months to check for activity (default 6)',
      },
      include_funded: {
        type: 'boolean',
        description: 'Include categories that have funds but no spending (default false)',
      },
    },
    required: [],
  },
};

interface UnusedCategory {
  category_name: string;
  group_name: string;
  balance: string;
  balance_raw: number;
  budgeted_this_month: string;
  budgeted_raw: number;
  has_goal: boolean;
  last_activity: string | null;
  suggestion: string;
}

// Handler function
export async function handleUnusedCategories(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const months = validated.months ?? 6;
  const includeFunded = validated.include_funded ?? false;

  // Calculate since date
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - months);
  const sinceDateStr = sinceDate.toISOString().split('T')[0] ?? '';

  // Get transactions and categories
  const [transactionsResponse, categoriesResponse] = await Promise.all([
    client.getTransactions(budgetId, { sinceDate: sinceDateStr }),
    client.getCategories(budgetId),
  ]);

  // Build set of active category IDs
  const activeCategoryIds = new Set<string>();
  const lastActivityMap = new Map<string, string>();

  for (const txn of transactionsResponse.data.transactions) {
    if (txn.category_id && !txn.deleted) {
      activeCategoryIds.add(txn.category_id);
      const existing = lastActivityMap.get(txn.category_id);
      if (!existing || txn.date > existing) {
        lastActivityMap.set(txn.category_id, txn.date);
      }
    }
  }

  // Find unused categories
  const unusedCategories: UnusedCategory[] = [];

  for (const group of categoriesResponse.data.category_groups) {
    // Skip internal categories
    if (group.name === 'Internal Master Category' || group.hidden) {
      continue;
    }

    for (const category of group.categories) {
      // Skip hidden categories
      if (category.hidden) {
        continue;
      }

      const isActive = activeCategoryIds.has(category.id);
      const balance = category.balance;
      const budgeted = category.budgeted;
      const hasGoal = category.goal_type !== null && category.goal_type !== undefined;

      // Determine if category is "unused"
      const isUnused = !isActive;
      const hasFunds = balance > 0 || budgeted > 0;

      // Skip if has funds and we're not including funded categories
      if (isUnused && hasFunds && !includeFunded) {
        continue;
      }

      if (isUnused) {
        // Determine suggestion
        let suggestion: string;
        if (hasGoal) {
          suggestion = 'Has a goal - verify if still needed';
        } else if (balance > 0) {
          suggestion = 'Has funds but no activity - consider moving funds elsewhere';
        } else if (budgeted > 0) {
          suggestion = 'Has budget but no spending - may not need funding';
        } else {
          suggestion = 'No activity or funds - safe to hide or delete';
        }

        unusedCategories.push({
          category_name: sanitizeName(category.name),
          group_name: sanitizeName(group.name),
          balance: formatCurrency(balance),
          balance_raw: balance,
          budgeted_this_month: formatCurrency(budgeted),
          budgeted_raw: budgeted,
          has_goal: hasGoal,
          last_activity: lastActivityMap.get(category.id) ?? null,
          suggestion,
        });
      }
    }
  }

  // Group by category group
  const byGroup = new Map<string, UnusedCategory[]>();
  for (const cat of unusedCategories) {
    if (!byGroup.has(cat.group_name)) {
      byGroup.set(cat.group_name, []);
    }
    byGroup.get(cat.group_name)!.push(cat);
  }

  // Calculate total categories
  let totalCategories = 0;
  for (const group of categoriesResponse.data.category_groups) {
    if (group.name !== 'Internal Master Category' && !group.hidden) {
      totalCategories += group.categories.filter((c) => !c.hidden).length;
    }
  }

  // Categorize by cleanup potential
  const safeToRemove = unusedCategories.filter(
    (c) => c.balance_raw === 0 && c.budgeted_raw === 0 && !c.has_goal
  );
  const needsReview = unusedCategories.filter(
    (c) => c.balance_raw !== 0 || c.budgeted_raw !== 0 || c.has_goal
  );

  return JSON.stringify(
    {
      period: {
        months_checked: months,
        since_date: sinceDateStr,
      },
      summary: {
        total_categories: totalCategories,
        unused_categories: unusedCategories.length,
        percent_unused: totalCategories > 0 ? Math.round((unusedCategories.length / totalCategories) * 100) : 0,
        safe_to_remove: safeToRemove.length,
        needs_review: needsReview.length,
      },
      categories: {
        safe_to_remove: safeToRemove.map((c) => ({
          category: c.category_name,
          group: c.group_name,
          suggestion: c.suggestion,
        })),
        needs_review: needsReview.map((c) => ({
          category: c.category_name,
          group: c.group_name,
          balance: c.balance,
          has_goal: c.has_goal,
          suggestion: c.suggestion,
        })),
      },
      by_group: Array.from(byGroup.entries()).map(([group, cats]) => ({
        group,
        count: cats.length,
        categories: cats.map((c) => c.category_name),
      })),
      tips: [
        'Review categories before deleting to avoid losing historical data',
        'Consider hiding categories instead of deleting to preserve history',
        'Move any remaining funds to other categories before cleanup',
      ],
    },
    null,
    2
  );
}
