/**
 * Overspending Triage Prompt
 *
 * Rule 3 — Roll With the Punches. Finds current overspending and moves
 * money from categories with slack, plus surfaces discretionary cuts.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export const overspendingTriagePrompt: Prompt = {
  name: 'ynab-overspending-triage',
  title: 'Overspending Triage',
  description:
    'Finds where money is being overspent and helps roll with the punches: move funds from categories with slack, and surface discretionary cuts. Use for "find places I\'m overspending", "where did I overspend", "help me fix overspending", "roll with the punches", "where can I find extra money", or "help me cut back this month". Not for computing true-expense monthly contributions (use ynab-true-expenses) or the initial "assign new money" pass (use ynab-assign-money) — this is remediation of overspending, not allocation of unassigned money.',
};

export function buildOverspendingTriageMessages(): { description: string; messages: PromptMessage[] } {
  return {
    description: 'Find and fix current overspending.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Help me find and fix overspending in my budget right now.

Call these tools, in order:
1. ynab_overspending_alerts
2. ynab_budget_vs_actuals — for variance context
3. ynab_category_balances (filter: "positive") — to find categories with slack to pull from
4. ynab_savings_opportunities (months: 3)
5. ynab_spending_by_payee — to surface the specific merchants driving overspending

Then synthesize:
- Currently overspent categories (amount over, and how many days until the category resets)
- Candidates to pull from — positive-balance, lower-priority categories with amounts available
- Suggested moves: "move $X from [A] to [B]" for each overspent category
- Cut opportunities (subscriptions, high-variance spending, one-off purchases) with estimated dollar impact

Present the suggested moves for confirmation before making any changes.`,
        },
      },
    ],
  };
}
