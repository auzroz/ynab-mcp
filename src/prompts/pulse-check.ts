/**
 * Pulse Check Prompt
 *
 * Fast, at-a-glance snapshot of the budget right now.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export const pulseCheckPrompt: Prompt = {
  name: 'ynab-pulse-check',
  title: 'Pulse Check',
  description:
    'Fast daily-style status check: Ready to Assign, overspending flags, spending pace, and an overall health score. Use for "how am I doing this month", "how\'s my budget looking", "quick check on my finances", or "am I on track". Not for a full monthly review (use ynab-monthly-review) or fixing overspending (use ynab-overspending-triage).',
};

export function buildPulseCheckMessages(): { description: string; messages: PromptMessage[] } {
  return {
    description: 'A fast snapshot of the current budget state.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Give me a quick pulse check on my YNAB budget.

Call these tools, in order:
1. ynab_quick_summary
2. ynab_budget_health
3. ynab_overspending_alerts
4. ynab_spending_pace

Then synthesize a short status report:
- Ready to Assign and overall health score
- Any overspent categories (or "none")
- Spending pace vs. target, and the projected month-end total
- One-sentence top action item, if anything needs attention

Keep it brief — this is a quick check-in, not a full review.`,
        },
      },
    ],
  };
}
