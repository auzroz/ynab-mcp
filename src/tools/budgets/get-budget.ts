/**
 * Get Budget Tool
 * 
 * Returns detailed information about a specific budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, formatCurrencyWithFormat } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const getBudgetTool: Tool = {
  name: 'ynab_get_budget',
  description: `Get detailed information about a specific budget including accounts, categories, and payees.

Use when the user asks:
- "Show me my budget details"
- "What's in my budget?"
- "Give me an overview of my budget"
- "Tell me about my main budget"

Returns comprehensive budget data including all accounts, category groups, categories, and payees.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
  },
};

// Handler function
/**
 * Handler for the ynab_get_budget tool.
 */
export async function handleGetBudget(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  
  // Use delta sync if we have prior knowledge
  const lastKnowledge = client.getServerKnowledge(budgetId);
  const response = await client.getBudgetById(budgetId, lastKnowledge);
  const budget = response.data.budget;

  // Helper to format currency using budget's format if available
  const fmt = (milliunits: number): string =>
    budget.currency_format
      ? formatCurrencyWithFormat(milliunits, budget.currency_format)
      : formatCurrency(milliunits);

  // Summarize accounts by type
  const accountsByType: Record<string, Array<{ name: string; balance: string }>> = {};
  for (const account of budget.accounts ?? []) {
    if (account.closed) continue;
    const type = account.type;
    if (accountsByType[type] === undefined) {
      accountsByType[type] = [];
    }
    accountsByType[type].push({
      name: sanitizeName(account.name),
      balance: fmt(account.balance),
    });
  }

  // Calculate totals
  const assetTypes = ['checking', 'savings', 'cash', 'otherAsset'];
  const liabilityTypes = [
    'creditCard',
    'lineOfCredit',
    'otherLiability',
    'mortgage',
    'autoLoan',
    'studentLoan',
    'personalLoan',
    'medicalDebt',
    'otherDebt',
  ];

  const totalAssets = (budget.accounts ?? [])
    .filter((a) => !a.closed && assetTypes.includes(String(a.type)))
    .reduce((sum, a) => sum + a.balance, 0);

  const totalLiabilities = (budget.accounts ?? [])
    .filter((a) => !a.closed && liabilityTypes.includes(String(a.type)))
    .reduce((sum, a) => sum + Math.abs(a.balance), 0);

  // Summarize categories
  const categoryGroups = (budget.category_groups ?? [])
    .filter((g) => !g.hidden && g.name !== 'Internal Master Category')
    .map((group) => ({
      name: sanitizeName(group.name),
      categories: (budget.categories ?? [])
        .filter((c) => c.category_group_id === group.id && !c.hidden)
        .map((c) => ({
          name: sanitizeName(c.name),
          budgeted: fmt(c.budgeted),
          activity: fmt(c.activity),
          balance: fmt(c.balance),
        })),
    }));

  return JSON.stringify(
    {
      budget_id: budget.id,
      name: sanitizeName(budget.name),
      last_modified: budget.last_modified_on,
      summary: {
        total_assets: fmt(totalAssets),
        total_liabilities: fmt(totalLiabilities),
        net_worth: fmt(totalAssets - totalLiabilities),
        account_count: (budget.accounts ?? []).filter((a) => !a.closed).length,
        category_count: (budget.categories ?? []).filter((c) => !c.hidden).length,
        payee_count: (budget.payees ?? []).length,
      },
      accounts_by_type: accountsByType,
      category_groups: categoryGroups,
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
