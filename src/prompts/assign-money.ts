/**
 * Assign Money Prompt
 *
 * Rule 1 — Give Every Dollar a Job. Helps allocate unassigned Ready to
 * Assign money and fund underfunded goals.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export const assignMoneyPrompt: Prompt = {
  name: 'ynab-assign-money',
  title: 'Assign Money',
  description:
    'Helps give every dollar a job: assigns unallocated Ready to Assign money to categories, funds underfunded goals, and sets up new categories. Use for "I have money to assign", "help me budget this month", "what should I fund", "help me set up a new category", "organize my budget categories", or "assign my leftover funds". Not for fixing already-overspent categories (use ynab-overspending-triage) or the initial category structure of a brand-new budget (that\'s a bigger first-time-setup conversation).',
};

export function buildAssignMoneyMessages(): { description: string; messages: PromptMessage[] } {
  return {
    description: 'Help assigning unallocated Ready to Assign money.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Help me assign my unallocated Ready to Assign money.

Call these tools, in order:
1. ynab_quick_summary — get the current Ready to Assign amount
2. ynab_category_balances (filter: "unfunded")
3. ynab_goal_progress (filter: "underfunded")
4. ynab_budget_suggestions

Then synthesize:
- Ready to Assign amount
- A priority funding order: underfunded goal categories first (with amount needed), then unfunded/negative categories, then suggestions from spending history
- A proposed allocation (category: amount) — do not create or change anything until I confirm

If Ready to Assign is negative, or there's an already-overspent category eating into it, say so and suggest the overspending-triage workflow instead of proceeding with this allocation.`,
        },
      },
    ],
  };
}
