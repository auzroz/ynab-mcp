/**
 * True Expenses Prompt
 *
 * Rule 2 — Embrace Your True Expenses. Finds irregular/infrequent costs and
 * missing recurring bills, and plans monthly contributions for them.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export const trueExpensesPrompt: Prompt = {
  name: 'ynab-true-expenses',
  title: 'True Expenses',
  description:
    'Finds and plans for irregular or infrequent costs — annual subscriptions, car repairs, holiday spending, insurance premiums — and detects recurring bills that may be missing from the budget or scheduled transactions. Use for "help me plan for an annual expense", "I have a big bill coming up", "make sure my recurring bills are captured", "set up a sinking fund", "did I forget any subscriptions", or "embrace my true expenses". Not for general new-category creation unrelated to irregular costs (use ynab-assign-money) or fixing an already-overspent category (use ynab-overspending-triage).',
};

export function buildTrueExpensesMessages(): { description: string; messages: PromptMessage[] } {
  return {
    description: 'Find and plan for irregular/true expenses.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Help me embrace my true expenses — find irregular costs and recurring bills I should be planning for.

Call these tools, in order:
1. ynab_detect_recurring (months: 6)
2. ynab_list_categories and ynab_unused_categories (months: 6) — cross-check for categories that should exist but don't
3. ynab_spending_analysis or ynab_spending_trends for the irregular categories you find

For each irregular or missing-recurring item found, compute a suggested monthly contribution (annual cost ÷ 12, or ÷ months-until-due if there's a known due date), then propose:
- Creating a category (ynab_create_category) and funding it (ynab_update_category), if one doesn't already exist
- Creating a scheduled transaction (first preview with ynab_preview_scheduled_transaction, then ynab_create_scheduled_transaction) for detected-but-unscheduled recurring charges
- A sanity check with ynab_cash_flow_forecast to confirm the new commitment doesn't strain the next 30 days

Do not create or change anything until I confirm each proposal.`,
        },
      },
    ],
  };
}
