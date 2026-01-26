/**
 * Reconciliation Helper Tool
 *
 * Shows uncleared transactions to help with account reconciliation.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID or "last-used". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  account_id: z
    .string()
    .uuid()
    .optional()
    .describe('Specific account UUID to check (optional, shows all if not specified)'),
}).strict();

// Tool definition
export const reconciliationHelperTool: Tool = {
  name: 'ynab_reconciliation_helper',
  description: `Help with account reconciliation by showing uncleared transactions.

Use when the user asks:
- "Help me reconcile my accounts"
- "What transactions haven't cleared?"
- "Show uncleared transactions"
- "Pending transactions"
- "Reconciliation status"

Returns uncleared transactions organized by account with totals.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID or "last-used". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      account_id: {
        type: 'string',
        format: 'uuid',
        description: 'Specific account ID to check (optional)',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

interface UnclearedTransaction {
  date: string;
  payee: string;
  category: string | null;
  amount: string;
  amount_raw: number;
  memo: string | null;
  days_pending: number;
}

interface AccountReconciliation {
  account_name: string;
  account_type: string;
  cleared_balance: string;
  uncleared_balance: string;
  working_balance: string;
  uncleared_count: number;
  uncleared_transactions: UnclearedTransaction[];
  oldest_uncleared: string | null;
}

// Handler function
/**
 * Handler for the ynab_reconciliation_helper tool.
 */
export async function handleReconciliationHelper(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Get accounts and transactions (limit to last 90 days for reconciliation)
  const lookbackDays = 90;
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - lookbackDays);
  const sinceDateStr = sinceDate.toISOString().split('T')[0] ?? '';

  const [accountsResponse, transactionsResponse, categoriesResponse] = await Promise.all([
    client.getAccounts(budgetId),
    client.getTransactions(budgetId, { sinceDate: sinceDateStr }),
    client.getCategories(budgetId),
  ]);

  // Build category lookup
  const categoryLookup = new Map<string, string>();
  for (const group of categoriesResponse.data.category_groups) {
    for (const cat of group.categories) {
      categoryLookup.set(cat.id, cat.name);
    }
  }

  // Filter accounts
  let accounts = accountsResponse.data.accounts.filter(
    (a) => !a.deleted && !a.closed
  );

  if (validated.account_id) {
    accounts = accounts.filter((a) => a.id === validated.account_id);
    if (accounts.length === 0) {
      throw new Error('Account not found for provided account_id');
    }
  }

  // Get today for calculating days pending
  const today = new Date();

  // Group uncleared transactions by account
  const accountData = new Map<string, AccountReconciliation>();

  for (const account of accounts) {
    accountData.set(account.id, {
      account_name: sanitizeName(account.name),
      account_type: String(account.type),
      cleared_balance: formatCurrency(account.cleared_balance),
      uncleared_balance: formatCurrency(account.uncleared_balance),
      working_balance: formatCurrency(account.balance),
      uncleared_count: 0,
      uncleared_transactions: [],
      oldest_uncleared: null,
    });
  }

  // Process transactions
  const transactions = transactionsResponse.data.transactions.filter(
    (t) => !t.deleted && String(t.cleared) !== 'reconciled' && String(t.cleared) !== 'cleared'
  );

  for (const txn of transactions) {
    const accountInfo = accountData.get(txn.account_id);
    if (!accountInfo) continue;

    // Calculate days pending (clamp to 0 for future-dated transactions)
    const txnDate = new Date(txn.date);
    const daysPending = Math.max(
      0,
      Math.floor((today.getTime() - txnDate.getTime()) / (1000 * 60 * 60 * 24))
    );

    const unclearedTxn: UnclearedTransaction = {
      date: txn.date,
      payee: sanitizeName(txn.payee_name ?? ''),
      category: txn.category_id
        ? (categoryLookup.get(txn.category_id)
            ? sanitizeName(categoryLookup.get(txn.category_id)!)
            : null)
        : null,
      amount: formatCurrency(txn.amount),
      amount_raw: txn.amount,
      memo: sanitizeMemo(txn.memo),
      days_pending: daysPending,
    };

    accountInfo.uncleared_transactions.push(unclearedTxn);
    accountInfo.uncleared_count++;

    // Track oldest uncleared
    if (!accountInfo.oldest_uncleared || txn.date < accountInfo.oldest_uncleared) {
      accountInfo.oldest_uncleared = txn.date;
    }
  }

  // Sort transactions by date (oldest first) for each account
  for (const [, info] of accountData) {
    info.uncleared_transactions.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Convert to array and filter out accounts with no uncleared transactions (unless specific account requested)
  let accountResults = Array.from(accountData.values());
  if (!validated.account_id) {
    accountResults = accountResults.filter((a) => a.uncleared_count > 0);
  }

  // Sort by uncleared count (most first)
  accountResults.sort((a, b) => b.uncleared_count - a.uncleared_count);

  // Calculate totals from all active accounts
  const activeAccountIds = new Set(accountData.keys());
  const activeAccountTransactions = transactions.filter((t) => activeAccountIds.has(t.account_id));
  const totalUncleared = sumMilliunits(activeAccountTransactions.map((t) => t.amount));
  const totalUnclearedCount = activeAccountTransactions.length;

  // Find accounts needing attention (old uncleared transactions)
  const needsAttention = accountResults.filter((a) => {
    if (!a.oldest_uncleared) return false;
    const oldestDate = new Date(a.oldest_uncleared);
    const daysPending = Math.floor(
      (today.getTime() - oldestDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysPending > 7;
  });

  // Determine status
  let status: 'up_to_date' | 'needs_attention' | 'overdue';
  let message: string;

  if (totalUnclearedCount === 0) {
    status = 'up_to_date';
    message = 'All transactions are cleared or reconciled';
  } else if (needsAttention.length > 0) {
    status = 'overdue';
    message = `${needsAttention.length} account(s) have transactions pending over a week`;
  } else {
    status = 'needs_attention';
    message = `${totalUnclearedCount} transaction(s) pending across ${accountResults.length} account(s)`;
  }

  return JSON.stringify(
    {
      status,
      message,
      summary: {
        lookback_days: lookbackDays,
        since_date: sinceDateStr,
        accounts_with_uncleared: accountResults.filter((a) => a.uncleared_count > 0).length,
        total_uncleared_transactions: totalUnclearedCount,
        total_uncleared_amount: formatCurrency(totalUncleared),
        accounts_needing_attention: needsAttention.length,
      },
      accounts: accountResults.map((a) => ({
        account: a.account_name,
        type: a.account_type,
        cleared_balance: a.cleared_balance,
        uncleared_balance: a.uncleared_balance,
        working_balance: a.working_balance,
        uncleared_count: a.uncleared_count,
        oldest_pending: a.oldest_uncleared,
        transactions: a.uncleared_transactions.slice(0, 10).map((t) => ({
          date: t.date,
          payee: t.payee,
          category: t.category,
          amount: t.amount,
          days_pending: t.days_pending,
          memo: t.memo,
        })),
      })),
      tips: [
        'Mark transactions as cleared when they appear on your bank statement',
        'Reconcile accounts regularly to catch discrepancies early',
        'Transactions pending over 7 days may need investigation',
      ],
    },
    null,
    2
  );
}
