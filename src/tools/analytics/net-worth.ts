/**
 * Net Worth Tool
 *
 * Calculates net worth from all accounts including tracking accounts.
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
  include_closed: z
    .boolean()
    .optional()
    .describe('Include closed accounts in calculation (default false)'),
});

// Tool definition
export const netWorthTool: Tool = {
  name: 'ynab_net_worth',
  description: `Calculate total net worth from all accounts.

Use when the user asks:
- "What's my net worth?"
- "How much do I have in total?"
- "Show all my account balances"
- "What are my assets and liabilities?"

Includes both budget accounts and tracking accounts (investments, property, etc.).
Returns breakdown by account type with total assets, liabilities, and net worth.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      include_closed: {
        type: 'boolean',
        description: 'Include closed accounts in calculation (default false)',
      },
    },
    required: [],
  },
};

interface AccountSummary {
  name: string;
  type: string;
  balance: string;
  balance_raw: number;
  on_budget: boolean;
}

interface AccountTypeGroup {
  type: string;
  accounts: AccountSummary[];
  total: string;
  total_raw: number;
}

// Handler function
export async function handleNetWorth(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const includeClosed = validated.include_closed ?? false;

  // Get all accounts
  const accountsResponse = await client.getAccounts(budgetId);

  // Filter accounts
  let accounts = accountsResponse.data.accounts.filter((a) => !a.deleted);
  if (!includeClosed) {
    accounts = accounts.filter((a) => !a.closed);
  }

  // Categorize account types
  const assetTypes = new Set([
    'checking',
    'savings',
    'cash',
    'otherAsset',
  ]);

  const debtTypes = new Set([
    'creditCard',
    'lineOfCredit',
    'mortgage',
    'autoLoan',
    'studentLoan',
    'personalLoan',
    'medicalDebt',
    'otherDebt',
    'otherLiability',
  ]);

  // Group accounts by type
  const byType = new Map<string, AccountSummary[]>();

  for (const account of accounts) {
    const typeStr = String(account.type);

    if (!byType.has(typeStr)) {
      byType.set(typeStr, []);
    }

    byType.get(typeStr)!.push({
      name: sanitizeName(account.name),
      type: typeStr,
      balance: formatCurrency(account.balance),
      balance_raw: account.balance,
      on_budget: account.on_budget,
    });
  }

  // Build type groups
  const typeGroups: AccountTypeGroup[] = [];
  for (const [type, accts] of byType) {
    const total = sumMilliunits(accts.map((a) => a.balance_raw));
    typeGroups.push({
      type,
      accounts: accts.sort((a, b) => b.balance_raw - a.balance_raw),
      total: formatCurrency(total),
      total_raw: total,
    });
  }

  // Sort by total (highest first for assets, lowest first for debts)
  typeGroups.sort((a, b) => b.total_raw - a.total_raw);

  // Calculate totals
  const budgetAccounts = accounts.filter((a) => a.on_budget);
  const trackingAccounts = accounts.filter((a) => !a.on_budget);

  // Assets: Include all asset-type accounts (checking, savings, cash, otherAsset)
  // plus tracking accounts with positive balances (investments, property, etc.)
  // Note: Asset-type accounts with negative balances (overdrafts) are included
  // in the filter but will have negative contribution to total assets.
  // Tracking accounts with zero or negative balance are excluded from assets.
  const assetAccounts = accounts.filter(
    (a) => assetTypes.has(String(a.type)) || (!a.on_budget && a.balance > 0)
  );
  // Sum all asset account balances (including negative overdrafts for accurate net worth)
  const totalAssets = sumMilliunits(
    assetAccounts.map((a) => a.balance)
  );

  // Liabilities (debt accounts + negative balances)
  const debtAccounts = accounts.filter((a) => debtTypes.has(String(a.type)));
  const totalLiabilities = sumMilliunits(
    debtAccounts.map((a) => Math.abs(a.balance))
  );

  // Net worth
  const netWorth = sumMilliunits(accounts.map((a) => a.balance));

  // Budget vs tracking breakdown
  const budgetTotal = sumMilliunits(budgetAccounts.map((a) => a.balance));
  const trackingTotal = sumMilliunits(trackingAccounts.map((a) => a.balance));

  // Determine status
  let status: 'positive' | 'negative' | 'zero';
  let message: string;

  if (netWorth > 0) {
    status = 'positive';
    message = 'Net worth is positive';
  } else if (netWorth < 0) {
    status = 'negative';
    message = 'Net worth is negative - liabilities exceed assets';
  } else {
    status = 'zero';
    message = 'Assets equal liabilities';
  }

  return JSON.stringify(
    {
      status,
      message,
      net_worth: formatCurrency(netWorth),
      summary: {
        total_assets: formatCurrency(totalAssets),
        total_liabilities: formatCurrency(totalLiabilities),
        net_worth: formatCurrency(netWorth),
      },
      breakdown: {
        budget_accounts: {
          count: budgetAccounts.length,
          total: formatCurrency(budgetTotal),
        },
        tracking_accounts: {
          count: trackingAccounts.length,
          total: formatCurrency(trackingTotal),
        },
      },
      by_account_type: typeGroups.map((g) => ({
        type: g.type,
        total: g.total,
        accounts: g.accounts.map((a) => ({
          name: a.name,
          balance: a.balance,
          on_budget: a.on_budget,
        })),
      })),
      account_count: {
        total: accounts.length,
        budget: budgetAccounts.length,
        tracking: trackingAccounts.length,
        closed_excluded: includeClosed ? 0 : accountsResponse.data.accounts.filter((a) => a.closed && !a.deleted).length,
      },
    },
    null,
    2
  );
}
