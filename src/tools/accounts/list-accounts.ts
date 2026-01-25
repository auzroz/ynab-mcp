/**
 * List Accounts Tool
 * 
 * Returns all accounts in a budget with balances.
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
  include_closed: z
    .boolean()
    .optional()
    .describe('Whether to include closed accounts'),
});

// Tool definition
export const listAccountsTool: Tool = {
  name: 'ynab_list_accounts',
  description: `List all accounts in a budget with their current balances.

Use when the user asks:
- "What accounts do I have?"
- "Show my account balances"
- "What's my net worth?"
- "List my bank accounts"
- "How much money do I have?"

Returns account names, types, and current/cleared/uncleared balances.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      include_closed: {
        type: 'boolean',
        description: 'Whether to include closed accounts',
      },
    },
  },
};

// Handler function
export async function handleListAccounts(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const includeClosed = validated.include_closed ?? false;

  const response = await client.getAccounts(budgetId);
  let accounts = response.data.accounts;

  if (!includeClosed) {
    accounts = accounts.filter((a) => !a.closed);
  }

  // Group by account type
  const byType: Record<string, Array<{
    id: string;
    name: string;
    balance: string;
    cleared_balance: string;
    uncleared_balance: string;
    closed: boolean;
  }>> = {};

  for (const account of accounts) {
    const type = account.type;
    if (byType[type] === undefined) {
      byType[type] = [];
    }
    byType[type].push({
      id: account.id,
      name: sanitizeName(account.name),
      balance: formatCurrency(account.balance),
      cleared_balance: formatCurrency(account.cleared_balance),
      uncleared_balance: formatCurrency(account.uncleared_balance),
      closed: account.closed,
    });
  }

  // Calculate totals
  const assetTypes: string[] = ['checking', 'savings', 'cash', 'otherAsset'];
  const liabilityTypes: string[] = [
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

  const totalAssets = accounts
    .filter((a) => assetTypes.includes(String(a.type)))
    .reduce((sum, a) => sum + a.balance, 0);

  const totalLiabilities = accounts
    .filter((a) => liabilityTypes.includes(String(a.type)))
    .reduce((sum, a) => sum + Math.abs(a.balance), 0);

  return JSON.stringify(
    {
      accounts_by_type: byType,
      summary: {
        total_accounts: accounts.length,
        total_assets: formatCurrency(totalAssets),
        total_liabilities: formatCurrency(totalLiabilities),
        net_worth: formatCurrency(totalAssets - totalLiabilities),
      },
    },
    null,
    2
  );
}
