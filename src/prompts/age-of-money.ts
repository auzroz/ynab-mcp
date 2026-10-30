/**
 * Age of Money Prompt
 *
 * Rule 4 — Age Your Money. Checks the cash cushion, the credit card float,
 * and near-term cash flow.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export const ageOfMoneyPrompt: Prompt = {
  name: 'ynab-age-of-money',
  title: 'Age of Money Check',
  description:
    'Checks how healthy the cash cushion is: Age of Money, near-term cash flow forecast, and whether the credit card float is quietly draining the buffer. Use for "check my age of money", "am I living paycheck to paycheck", "how\'s my cash flow", "will I have enough before payday", or "is my credit card float catching up to me". Not for the overall month scorecard (use ynab-monthly-review, which references this in one line but doesn\'t forecast) or fixing overspending that\'s causing a low Age of Money (use ynab-overspending-triage).',
};

export function buildAgeOfMoneyMessages(): { description: string; messages: PromptMessage[] } {
  return {
    description: 'Check the cash cushion, credit card float, and near-term cash flow.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Check the health of my cash cushion.

Call these tools, in order:
1. ynab_age_of_money
2. ynab_credit_card_status
3. ynab_cash_flow_forecast (days: 30)
4. ynab_income_expense (months: 6)

Then synthesize:
- Age of Money in days, its status tier, and one relevant tip
- Credit card float check: card balance vs. payment-category balance — flag any shortfall, or confirm it's fully covered
- 30-day cash forecast: lowest projected balance and the date it occurs
- Savings rate trend over the last 6 months

If the numbers point to a structural overspending problem rather than just a timing issue, say so and suggest ynab-overspending-triage.`,
        },
      },
    ],
  };
}
