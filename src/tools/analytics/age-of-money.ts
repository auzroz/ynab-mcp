/**
 * Age of Money Tool
 *
 * Explains and tracks the Age of Money metric.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const ageOfMoneyTool: Tool = {
  name: 'ynab_age_of_money',
  description: `Get the Age of Money metric with explanation and tips.

Use when the user asks:
- "What's my age of money?"
- "How old is my money?"
- "Explain age of money"
- "Am I living on last month's income?"
- "How long does my money last?"

Returns the current age of money with context and improvement tips.`,
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
/**
 * Handler for the ynab_age_of_money tool.
 */
export async function handleAgeOfMoney(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Get budget details and accounts
  const [budgetResponse, accountsResponse] = await Promise.all([
    client.getBudgetById(budgetId),
    client.getAccounts(budgetId),
  ]);

  // Sort months by date (descending) to get the most recent month first
  // YNAB API doesn't guarantee months array order
  const months = budgetResponse.data.budget.months ?? [];
  const sortedMonths = [...months].sort((a, b) => b.month.localeCompare(a.month));
  const ageOfMoney = sortedMonths[0]?.age_of_money ?? null;

  // Calculate cash on hand (budget accounts only)
  const budgetAccounts = accountsResponse.data.accounts.filter(
    (a) => a.on_budget && !a.deleted && !a.closed
  );
  const cashOnHand = sumMilliunits(budgetAccounts.map((a) => a.balance));

  // Determine status and message
  let status: 'excellent' | 'good' | 'fair' | 'needs_work' | 'unknown';
  let message: string;
  let target: string;

  if (ageOfMoney === null) {
    status = 'unknown';
    message = 'Age of Money is not yet calculated. It requires at least 10 outflow transactions.';
    target = 'N/A';
  } else if (ageOfMoney >= 30) {
    status = 'excellent';
    message = `Your money is ${ageOfMoney} days old - you're living on last month's income!`;
    target = 'Maintain 30+ days';
  } else if (ageOfMoney >= 21) {
    status = 'good';
    message = `Your money is ${ageOfMoney} days old - getting close to the 30-day goal!`;
    target = 'Reach 30 days';
  } else if (ageOfMoney >= 14) {
    status = 'fair';
    message = `Your money is ${ageOfMoney} days old - making progress!`;
    target = 'Reach 21 days';
  } else {
    status = 'needs_work';
    message = `Your money is ${ageOfMoney} days old - room for improvement.`;
    target = 'Reach 14 days';
  }

  // Estimate days of buffer
  // This is a rough estimate based on cash on hand and implied spending rate
  let estimatedBuffer = 'Unknown';
  if (ageOfMoney !== null && ageOfMoney > 0) {
    // If we have X days of age of money with Y cash, the daily rate is roughly Y / X
    // But this is simplified - actual calculation is more complex
    estimatedBuffer = `~${ageOfMoney} days`;
  }

  return JSON.stringify(
    {
      status,
      message,
      age_of_money: ageOfMoney !== null ? `${ageOfMoney} days` : 'Not calculated yet',
      age_of_money_raw: ageOfMoney,
      target,
      context: {
        cash_on_hand: formatCurrency(cashOnHand),
        budget_accounts: budgetAccounts.length,
        estimated_buffer: estimatedBuffer,
      },
      explanation: {
        what_is_it:
          'Age of Money measures the average age of the dollars you spend. It shows how long money sits in your accounts before being spent.',
        why_it_matters:
          'A higher Age of Money means you have more buffer between earning and spending. At 30+ days, you\'re spending last month\'s income, not this month\'s.',
        how_calculated:
          'YNAB looks at the last 10 cash outflows and calculates how old those dollars were when spent, then averages them.',
      },
      milestones: [
        { days: 7, meaning: 'One week buffer' },
        { days: 14, meaning: 'Two week buffer' },
        { days: 21, meaning: 'Three week buffer' },
        { days: 30, meaning: 'Living on last month\'s income - YNAB\'s goal!' },
        { days: 60, meaning: 'Two month buffer - excellent financial health' },
        { days: 90, meaning: 'Three month buffer - very secure' },
      ],
      tips_to_improve:
        ageOfMoney !== null && ageOfMoney < 30
          ? [
              'Spend less than you earn each month',
              'Build up Ready to Assign instead of immediately budgeting everything',
              'Avoid using credit cards for cash-flow management',
              'Focus on reducing expenses in discretionary categories',
              'Consider a no-spend challenge to accelerate progress',
            ]
          : [
              'Great job! Maintain your buffer by continuing to spend less than you earn',
              'Consider building additional savings goals',
              'Your buffer protects you from unexpected expenses',
            ],
    },
    null,
    2
  );
}
