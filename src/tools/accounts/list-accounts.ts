/**
 * List Accounts Tool
 *
 * Returns all accounts in a budget with balances.
 *
 * Note: Currency formatting uses USD ($) symbols by default for display purposes.
 * The underlying data is always stored in milliunits regardless of currency.
 * To use the budget's actual currency format, use formatCurrencyWithFormat()
 * with the budget's currency_format settings (requires additional API call).
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
/**
 * Handler for the ynab_list_accounts tool.
 */
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

  // Calculate liability totals properly:
  // - Negative balances on liability accounts = actual debt
  // - Positive balances on liability accounts = credits (overpayments)
  const liabilityAccounts = accounts.filter((a) =>
    liabilityTypes.includes(String(a.type))
  );

  // Sum only negative balances as liabilities (Math.min ensures we only count debt)
  const totalLiabilities = liabilityAccounts.reduce(
    (sum, a) => sum + Math.min(0, a.balance),
    0
  );

  // Sum positive balances on liability accounts as credits
  const totalLiabilityCredits = liabilityAccounts.reduce(
    (sum, a) => sum + Math.max(0, a.balance),
    0
  );

  // Net worth = assets + liability credits - abs(liabilities)
  // Since totalLiabilities is negative (or zero), we add it
  const netWorth = totalAssets + totalLiabilityCredits + totalLiabilities;

  return JSON.stringify(
    {
      accounts_by_type: byType,
      summary: {
        total_accounts: accounts.length,
        total_assets: formatCurrency(totalAssets),
        // Display liabilities as a positive number for readability
        total_liabilities: formatCurrency(Math.abs(totalLiabilities)),
        // Show credits on liability accounts if any exist
        ...(totalLiabilityCredits > 0 && {
          liability_credits: formatCurrency(totalLiabilityCredits),
        }),
        net_worth: formatCurrency(netWorth),
      },
    },
    null,
    2
  );
}
