/**
 * Monthly Review Prompt
 *
 * End-of-month ritual: performance vs. plan, goal progress, income/savings
 * trend, net worth, and suggested targets for next month.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { InvalidPromptArgumentsError } from './errors.js';

// Matches the YYYY-MM-01 format the underlying ynab_budget_vs_actuals tool expects
// (same pattern used in src/tools/analytics/budget-vs-actuals.ts).
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-01$/;

// Empty or missing means "current month".
const monthArgSchema = z.union([z.literal(''), z.string().regex(MONTH_PATTERN)]).optional();

export const monthlyReviewPrompt: Prompt = {
  name: 'ynab-monthly-review',
  title: 'Monthly Review',
  description:
    'Runs a complete end-of-month budget review: this month\'s performance vs. plan, goal progress, income/savings trend, net worth change, and suggested targets for next month. Use for "let\'s do my monthly budget review", "end of month check-in", "how did this month go", "review my budget", "close out this month", or "help me plan next month\'s budget". Not for a quick daily-style check (use ynab-pulse-check), or deep reconciliation/cash-flow work (use ynab-reconcile-cleanup / ynab-age-of-money) — this flags those but doesn\'t deep-dive them.',
  arguments: [
    {
      name: 'month',
      description: 'Month to review in YYYY-MM-01 format (first of month). Defaults to the current month.',
      required: false,
    },
  ],
};

export function buildMonthlyReviewMessages(args: Record<string, string>): {
  description: string;
  messages: PromptMessage[];
} {
  // A malformed month (wrong format, or an attempt to inject extra text into the
  // prompt) is rejected as a client error rather than interpolated raw. An empty
  // or missing month means "current month".
  const parsed = monthArgSchema.safeParse(args['month']);
  if (!parsed.success) {
    throw new InvalidPromptArgumentsError('month must be YYYY-MM-01 (first of month)');
  }
  const month = parsed.data ? parsed.data : undefined;
  const monthClause = month ? ` for ${month}` : '';

  return {
    description: 'A complete end-of-month budget review.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Run my monthly budget review${monthClause}.

Call these tools, in order:
1. ynab_budget_vs_actuals${month ? ` (month: "${month}")` : ''} with include_previous: true
2. ynab_monthly_comparison
3. ynab_income_expense (months: 6)
4. ynab_goal_progress (filter: "all")
5. ynab_net_worth
6. ynab_age_of_money
7. ynab_reconciliation_helper
8. ynab_budget_suggestions (months: 3)

Then synthesize a review with these sections:
1. Scorecard — budgeted vs. actual by category group, variance %, status
2. What changed vs. last month — top 3 movers
3. Goals — counts of on-track / behind / underfunded, with names
4. Income & savings rate trend (6mo)
5. Net worth — this month vs. last
6. Housekeeping flags — Age of Money in days; number of uncleared transactions (if any, suggest running ynab-reconcile-cleanup)
7. Next month's suggested budget per category, offered for confirmation before creating or changing anything

Do not execute overspending fixes, a deep reconciliation walk, or a deep cash-flow forecast here — just flag if those are needed and point to the right follow-up.`,
        },
      },
    ],
  };
}
