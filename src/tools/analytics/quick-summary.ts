/**
 * Quick Summary Tool
 *
 * Provides an at-a-glance overview of budget status and key metrics.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { z } from 'zod';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const quickSummaryTool: Tool = {
  name: 'ynab_quick_summary',
  description: `Get a quick at-a-glance summary of the budget status.

Use when the user asks:
- "How's my budget looking?"
- "Give me a quick overview"
- "What's my financial status?"
- "Summary of my finances"
- "How much money do I have?"

Returns key metrics: available funds, spending this month, account balances, and alerts.
This is the best tool to use for general budget status questions.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
};

// Handler function
export async function handleQuickSummary(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const currentMonth = getCurrentMonth();

  // Get all the data we need in parallel
  const [monthResponse, accountsResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, currentMonth),
    client.getAccounts(budgetId),
  ]);

  const monthData = monthResponse.data.month;
  const accounts = accountsResponse.data.accounts.filter((a) => !a.closed && !a.deleted);

  // Calculate total available (Ready to Assign)
  const readyToAssign = monthData.to_be_budgeted;

  // Calculate account balances by type
  const debtTypes = new Set(['mortgage', 'autoLoan', 'studentLoan', 'personalLoan', 'medicalDebt', 'otherDebt']);
  const creditTypes = new Set(['creditCard', 'lineOfCredit']);
  const cashTypes = new Set(['checking', 'savings', 'cash']);

  const budgetAccounts = accounts.filter(
    (a) => a.on_budget && !debtTypes.has(String(a.type))
  );
  const trackingAccounts = accounts.filter((a) => !a.on_budget);
  const debtAccounts = accounts.filter(
    (a) => a.on_budget && creditTypes.has(String(a.type))
  );

  const totalBudgetAccountBalance = sumMilliunits(budgetAccounts.map((a) => a.balance));
  const totalTrackingBalance = sumMilliunits(trackingAccounts.map((a) => a.balance));
  const totalDebt = sumMilliunits(debtAccounts.map((a) => Math.abs(a.balance)));

  // Calculate this month's spending (negative activity)
  const thisMonthActivity = sumMilliunits(
    monthData.categories
      .filter((c) => c.activity < 0 && !c.hidden)
      .map((c) => Math.abs(c.activity))
  );

  // Get overspent categories
  const overspentCategories = monthData.categories
    .filter((c) => c.balance < 0 && !c.hidden)
    .map((c) => ({
      name: sanitizeName(c.name),
      overspent_by: formatCurrency(Math.abs(c.balance)),
    }));

  // Get underfunded goals
  const underfundedGoals = monthData.categories
    .filter((c) => (c.goal_under_funded ?? 0) > 0 && !c.hidden)
    .map((c) => ({
      name: sanitizeName(c.name),
      needed: formatCurrency(c.goal_under_funded ?? 0),
    }))
    .slice(0, 5);

  // Check for low balance accounts
  const lowBalanceAccounts = budgetAccounts
    .filter((a) => a.balance < 10000 && a.balance >= 0 && !creditTypes.has(String(a.type)))
    .map((a) => ({
      name: sanitizeName(a.name),
      balance: formatCurrency(a.balance),
    }));

  // Determine overall status
  let overallStatus: 'healthy' | 'warning' | 'attention_needed';
  let statusMessage: string;

  if (overspentCategories.length > 0) {
    overallStatus = 'attention_needed';
    statusMessage = `${overspentCategories.length} categories are overspent`;
  } else if (readyToAssign < 0) {
    overallStatus = 'attention_needed';
    statusMessage = 'Ready to Assign is negative - need to cover overspending';
  } else if (underfundedGoals.length > 3) {
    overallStatus = 'warning';
    statusMessage = 'Several goals need more funding';
  } else {
    overallStatus = 'healthy';
    statusMessage = 'Budget is on track';
  }

  return JSON.stringify(
    {
      status: overallStatus,
      message: statusMessage,
      month: currentMonth,
      key_metrics: {
        ready_to_assign: formatCurrency(readyToAssign),
        spent_this_month: formatCurrency(thisMonthActivity),
        total_in_budget_accounts: formatCurrency(totalBudgetAccountBalance),
        total_debt: formatCurrency(totalDebt),
        total_in_tracking_accounts: formatCurrency(totalTrackingBalance),
        age_of_money: monthData.age_of_money != null ? `${monthData.age_of_money} days` : null,
      },
      alerts: {
        overspent_categories: overspentCategories.length > 0 ? overspentCategories.slice(0, 5) : null,
        underfunded_goals: underfundedGoals.length > 0 ? underfundedGoals : null,
        low_balance_accounts: lowBalanceAccounts.length > 0 ? lowBalanceAccounts : null,
      },
      account_summary: {
        checking_savings: budgetAccounts
          .filter((a) => cashTypes.has(String(a.type)))
          .map((a) => ({ name: sanitizeName(a.name), balance: formatCurrency(a.balance) })),
        credit_cards: debtAccounts.map((a) => ({
          name: sanitizeName(a.name),
          balance: formatCurrency(a.balance),
        })),
      },
      tips:
        overallStatus !== 'healthy'
          ? [
              overspentCategories.length > 0
                ? 'Move money from other categories to cover overspending'
                : null,
              readyToAssign < 0
                ? 'Unassign money from categories to fix negative Ready to Assign'
                : null,
              underfundedGoals.length > 0
                ? 'Consider adjusting goals or finding more money to fund them'
                : null,
            ].filter(Boolean)
          : [],
    },
    null,
    2
  );
}
