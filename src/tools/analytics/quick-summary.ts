/**
 * Quick Summary Tool
 *
 * Provides an at-a-glance overview of budget status and key metrics.
 */

import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor, sumMilliunits } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { z } from 'zod';
import { budgetId } from '../../utils/schemas.js';
import { toOutputSchema } from '../output-schema.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

const nameBalance = z.object({ name: z.string(), balance: z.string() });

/** What the tool returns (#45; rules in ../output-schema.ts). Amounts are formatted strings; nulls here are reported on purpose. */
export const quickSummaryOutputSchema = z.object({
  status: z.enum(['healthy', 'warning', 'attention_needed']),
  message: z.string(),
  month: z.string(),
  key_metrics: z.object({
    ready_to_assign: z.string(),
    spent_this_month: z.string(),
    total_in_budget_accounts: z.string(),
    total_debt: z.string(),
    total_in_tracking_accounts: z.string(),
    age_of_money: z.string().nullable().describe('"N days"; null until YNAB has calculated it'),
  }),
  alerts: z.object({
    overspent_categories: z
      .array(z.object({ name: z.string(), overspent_by: z.string() }))
      .nullable()
      .describe('At most 5; null when there are none'),
    underfunded_goals: z
      .array(z.object({ name: z.string(), needed: z.string() }))
      .nullable()
      .describe('At most 5; null when there are none'),
    low_balance_accounts: z.array(nameBalance).nullable().describe('Under 10 in the budget currency; null when there are none'),
  }),
  account_summary: z.object({
    checking_savings: z.array(nameBalance),
    debt_accounts: z.array(nameBalance),
  }),
  tips: z.array(z.string()),
});
export type QuickSummaryOutput = z.output<typeof quickSummaryOutputSchema>;

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
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
  outputSchema: toOutputSchema(quickSummaryOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_quick_summary tool.
 */
export async function handleQuickSummary(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<QuickSummaryOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);
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
    (a) => a.on_budget && !debtTypes.has(String(a.type)) && !creditTypes.has(String(a.type))
  );
  const trackingAccounts = accounts.filter((a) => !a.on_budget);
  const debtAccounts = accounts.filter(
    (a) => a.on_budget && (creditTypes.has(String(a.type)) || debtTypes.has(String(a.type)))
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
      overspent_by: money(Math.abs(c.balance)),
    }));

  // Get underfunded goals
  const underfundedGoals = monthData.categories
    .filter((c) => (c.goal_under_funded ?? 0) > 0 && !c.hidden)
    .map((c) => ({
      name: sanitizeName(c.name),
      needed: money(c.goal_under_funded ?? 0),
    }))
    .slice(0, 5);

  // Check for low balance accounts
  const lowBalanceAccounts = budgetAccounts
    .filter((a) => a.balance < 10000 && a.balance >= 0)
    .map((a) => ({
      name: sanitizeName(a.name),
      balance: money(a.balance),
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

  return {
    status: overallStatus,
    message: statusMessage,
    month: currentMonth,
    key_metrics: {
      ready_to_assign: money(readyToAssign),
      spent_this_month: money(thisMonthActivity),
      total_in_budget_accounts: money(totalBudgetAccountBalance),
      total_debt: money(totalDebt),
      total_in_tracking_accounts: money(totalTrackingBalance),
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
        .map((a) => ({ name: sanitizeName(a.name), balance: money(a.balance) })),
      debt_accounts: debtAccounts.map((a) => ({
        name: sanitizeName(a.name),
        balance: money(a.balance),
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
          ].filter((tip): tip is string => tip !== null)
        : [],
  };
}
