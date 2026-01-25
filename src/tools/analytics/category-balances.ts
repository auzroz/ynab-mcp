/**
 * Category Balances Tool
 *
 * Quick check on category balances with optional filtering.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  filter: z
    .enum(['all', 'funded', 'unfunded', 'negative', 'positive'])
    .optional()
    .describe('Filter categories by balance status (default: all)'),
  group: z
    .string()
    .optional()
    .describe('Filter by category group name (partial match)'),
  search: z
    .string()
    .optional()
    .describe('Search category names (partial match)'),
});

// Tool definition
export const categoryBalancesTool: Tool = {
  name: 'ynab_category_balances',
  description: `Check category balances with optional filtering.

Use when the user asks:
- "What's my balance in [category]?"
- "How much do I have for groceries?"
- "Show category balances"
- "Which categories have money?"
- "What categories are negative?"

Returns current category balances with filtering options.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      filter: {
        type: 'string',
        enum: ['all', 'funded', 'unfunded', 'negative', 'positive'],
        description: 'Filter categories by balance status',
      },
      group: {
        type: 'string',
        description: 'Filter by category group name (partial match)',
      },
      search: {
        type: 'string',
        description: 'Search category names (partial match)',
      },
    },
    required: [],
  },
};

interface CategoryBalance {
  category_name: string;
  group_name: string;
  balance: number;
  budgeted: number;
  activity: number;
  goal_target: number | null;
}

// Handler function
/**
 * Handler for the ynab_category_balances tool.
 */
export async function handleCategoryBalances(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const filter = validated.filter ?? 'all';
  const currentMonth = getCurrentMonth();

  // Get month data and categories
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, currentMonth),
    client.getCategories(budgetId),
  ]);

  // Build group lookup
  const groupLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      groupLookup.set(cat.id, group.name);
    }
  }

  // Process categories
  let categories: CategoryBalance[] = [];

  for (const cat of monthResponse.data.month.categories) {
    const groupName = groupLookup.get(cat.id) ?? 'Other';
    if (groupName === 'Internal Master Category' || cat.hidden) continue;

    categories.push({
      category_name: sanitizeName(cat.name),
      group_name: sanitizeName(groupName),
      balance: cat.balance,
      budgeted: cat.budgeted,
      activity: cat.activity,
      goal_target: cat.goal_target ?? null,
    });
  }

  // Apply group filter
  if (validated.group) {
    const groupSearch = validated.group.toLowerCase();
    categories = categories.filter((c) =>
      c.group_name.toLowerCase().includes(groupSearch)
    );
  }

  // Apply name search
  if (validated.search) {
    const nameSearch = validated.search.toLowerCase();
    categories = categories.filter((c) =>
      c.category_name.toLowerCase().includes(nameSearch)
    );
  }

  // Apply balance filter
  switch (filter) {
    case 'funded':
      // Categories that have been budgeted this month (regardless of current balance)
      categories = categories.filter((c) => c.budgeted > 0);
      break;
    case 'unfunded':
      categories = categories.filter((c) => c.balance === 0 && c.budgeted === 0);
      break;
    case 'negative':
      categories = categories.filter((c) => c.balance < 0);
      break;
    case 'positive':
      // Categories with positive available balance
      categories = categories.filter((c) => c.balance > 0);
      break;
  }

  // Sort by balance (highest first)
  categories.sort((a, b) => b.balance - a.balance);

  // Calculate totals
  const totalBalance = sumMilliunits(categories.map((c) => c.balance));
  const totalBudgeted = sumMilliunits(categories.map((c) => c.budgeted));
  const totalActivity = sumMilliunits(categories.map((c) => c.activity));

  // Group by category group
  const byGroup = new Map<string, CategoryBalance[]>();
  for (const cat of categories) {
    if (!byGroup.has(cat.group_name)) {
      byGroup.set(cat.group_name, []);
    }
    byGroup.get(cat.group_name)!.push(cat);
  }

  // Build group summaries with raw balance for sorting
  const groupSummaries = Array.from(byGroup.entries()).map(([group, cats]) => {
    const totalBalanceRaw = sumMilliunits(cats.map((c) => c.balance));
    return {
      group,
      category_count: cats.length,
      total_balance: formatCurrency(totalBalanceRaw),
      _rawBalance: totalBalanceRaw,
      categories: cats.map((c) => ({
        name: c.category_name,
        balance: formatCurrency(c.balance),
        budgeted: formatCurrency(c.budgeted),
        activity: formatCurrency(c.activity),
      })),
    };
  });

  // Sort groups by total balance (using raw numeric value)
  groupSummaries.sort((a, b) => b._rawBalance - a._rawBalance);

  // Build search description (sanitize user input)
  const filterDesc: string[] = [];
  if (filter !== 'all') filterDesc.push(`filter: ${filter}`);
  if (validated.group) filterDesc.push(`group: "${sanitizeString(validated.group, 100) ?? ''}"`);
  if (validated.search) filterDesc.push(`search: "${sanitizeString(validated.search, 100) ?? ''}"`);

  return JSON.stringify(
    {
      month: currentMonth,
      filter: filterDesc.length > 0 ? filterDesc.join(', ') : 'none',
      summary: {
        categories_shown: categories.length,
        total_balance: formatCurrency(totalBalance),
        total_budgeted: formatCurrency(totalBudgeted),
        total_activity: formatCurrency(totalActivity),
      },
      by_group: groupSummaries.map(({ _rawBalance, ...rest }) => rest),
      top_balances: categories.slice(0, 10).map((c) => ({
        category: c.category_name,
        group: c.group_name,
        balance: formatCurrency(c.balance),
        budgeted: formatCurrency(c.budgeted),
      })),
      negative_balances: categories
        .filter((c) => c.balance < 0)
        .map((c) => ({
          category: c.category_name,
          group: c.group_name,
          balance: formatCurrency(c.balance),
        })),
    },
    null,
    2
  );
}
