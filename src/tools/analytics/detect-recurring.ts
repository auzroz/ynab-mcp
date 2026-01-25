/**
 * Detect Recurring Transactions Tool
 *
 * Identifies recurring payments/subscriptions by analyzing transaction patterns.
 * Finds potential subscriptions that aren't in scheduled transactions.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import DecimalJS from 'decimal.js';

const Decimal = DecimalJS.default ?? DecimalJS;

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  months: z
    .number()
    .int()
    .min(3)
    .max(12)
    .optional()
    .describe('Number of months to analyze (default 6, min 3, max 12)'),
  min_occurrences: z
    .number()
    .int()
    .min(2)
    .max(10)
    .optional()
    .describe('Minimum occurrences to consider recurring (default 3)'),
});

// Tool definition
export const detectRecurringTool: Tool = {
  name: 'ynab_detect_recurring',
  description: `Detect recurring transactions (subscriptions, bills) by analyzing transaction patterns.

Use when the user asks:
- "What subscriptions do I have?"
- "Find my recurring bills"
- "What do I pay every month?"
- "Detect my regular payments"

Analyzes transaction history to find patterns and estimates monthly costs.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      months: {
        type: 'number',
        description: 'Number of months to analyze (default 6)',
      },
      min_occurrences: {
        type: 'number',
        description: 'Minimum occurrences to consider recurring (default 3)',
      },
    },
    required: [],
  },
};

interface RecurringTransaction {
  payee_name: string;
  category_name: string | null;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular';
  average_amount: string;
  last_date: string;
  next_expected: string | null;
  occurrence_count: number;
  total_spent: string;
  monthly_cost: string;
  confidence: 'high' | 'medium' | 'low';
}

// Handler function
export async function handleDetectRecurring(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const months = validated.months ?? 6;
  const minOccurrences = validated.min_occurrences ?? 3;

  // Calculate since_date using UTC to avoid timezone drift
  const now = new Date();
  const sinceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  const sinceDateStr = sinceDate.toISOString().split('T')[0] ?? '';

  // Get all transactions
  const options: { sinceDate: string } = { sinceDate: sinceDateStr };
  const transactionsResponse = await client.getTransactions(budgetId, options);

  const transactions = transactionsResponse.data.transactions.filter(
    (t) => t.amount < 0 && !t.deleted && !t.transfer_account_id // Only outflows, exclude transfers
  );

  // Group by payee
  const byPayee = new Map<
    string,
    {
      payee_name: string;
      payee_id: string;
      category_name: string | null;
      transactions: { date: string; amount: number }[];
    }
  >();

  for (const txn of transactions) {
    // Skip transactions without a payee_id - they can't be reliably grouped
    // and would create false recurring detections if merged under a single key
    if (!txn.payee_id) continue;

    const payeeId = txn.payee_id;
    const payeeName = txn.payee_name ?? 'Unknown';

    if (!byPayee.has(payeeId)) {
      byPayee.set(payeeId, {
        payee_name: payeeName,
        payee_id: payeeId,
        category_name: txn.category_name ?? null,
        transactions: [],
      });
    }

    byPayee.get(payeeId)!.transactions.push({
      date: txn.date,
      amount: txn.amount,
    });
  }

  // Analyze each payee for recurring patterns
  const recurring: RecurringTransaction[] = [];

  for (const [, data] of byPayee) {
    if (data.transactions.length < minOccurrences) continue;

    // Sort by date
    data.transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Calculate intervals between transactions
    const intervals: number[] = [];
    for (let i = 1; i < data.transactions.length; i++) {
      const current = data.transactions[i];
      const previous = data.transactions[i - 1];
      if (!current || !previous) continue;
      const diff =
        new Date(current.date).getTime() -
        new Date(previous.date).getTime();
      intervals.push(Math.round(diff / (1000 * 60 * 60 * 24))); // Days
    }

    if (intervals.length === 0) continue;

    // Calculate average interval and standard deviation
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance =
      intervals.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);

    // Determine frequency and confidence
    const { frequency, confidence } = classifyFrequency(avgInterval, stdDev);

    // Skip if too irregular
    if (frequency === 'irregular' && confidence === 'low') continue;

    // Calculate amounts
    const amounts = data.transactions.map((t) => Math.abs(t.amount));
    const totalSpent = sumMilliunits(amounts);
    const avgAmount = new Decimal(totalSpent).dividedBy(data.transactions.length).toNumber();

    // Calculate monthly cost
    const monthlyCost = calculateMonthlyCost(avgAmount, frequency);

    // Predict next occurrence
    const lastTxn = data.transactions[data.transactions.length - 1];
    if (!lastTxn) continue;
    const lastDate = lastTxn.date;
    const nextExpected = predictNextDate(lastDate, avgInterval);

    recurring.push({
      payee_name: sanitizeName(data.payee_name),
      category_name: data.category_name ? sanitizeName(data.category_name) : null,
      frequency,
      average_amount: formatCurrency(avgAmount),
      last_date: lastDate,
      next_expected: nextExpected,
      occurrence_count: data.transactions.length,
      total_spent: formatCurrency(totalSpent),
      monthly_cost: formatCurrency(monthlyCost),
      confidence,
    });
  }

  // Sort by monthly cost (highest first)
  recurring.sort((a, b) => {
    const costA = parseFloat(a.monthly_cost.replace(/[^0-9.-]/g, ''));
    const costB = parseFloat(b.monthly_cost.replace(/[^0-9.-]/g, ''));
    return costB - costA;
  });

  // Calculate totals
  const totalMonthly = recurring.reduce((sum, r) => {
    return sum + parseFloat(r.monthly_cost.replace(/[^0-9.-]/g, ''));
  }, 0);

  const highConfidence = recurring.filter((r) => r.confidence === 'high');
  const mediumConfidence = recurring.filter((r) => r.confidence === 'medium');

  return JSON.stringify(
    {
      recurring_transactions: recurring,
      summary: {
        total_recurring_found: recurring.length,
        high_confidence_count: highConfidence.length,
        medium_confidence_count: mediumConfidence.length,
        estimated_monthly_total: formatCurrency(Math.round(totalMonthly * 1000)),
        analysis_period: `${months} months`,
        since_date: sinceDateStr,
      },
      by_frequency: {
        weekly: recurring.filter((r) => r.frequency === 'weekly').length,
        biweekly: recurring.filter((r) => r.frequency === 'biweekly').length,
        monthly: recurring.filter((r) => r.frequency === 'monthly').length,
        quarterly: recurring.filter((r) => r.frequency === 'quarterly').length,
        annual: recurring.filter((r) => r.frequency === 'annual').length,
        irregular: recurring.filter((r) => r.frequency === 'irregular').length,
      },
    },
    null,
    2
  );
}

function classifyFrequency(
  avgInterval: number,
  stdDev: number
): { frequency: RecurringTransaction['frequency']; confidence: RecurringTransaction['confidence'] } {
  // Confidence based on consistency (lower stdDev = higher confidence)
  // Guard against division by zero when avgInterval is 0
  const coefficientOfVariation = avgInterval > 0 ? stdDev / avgInterval : 0;
  let confidence: RecurringTransaction['confidence'];

  if (coefficientOfVariation < 0.15) {
    confidence = 'high';
  } else if (coefficientOfVariation < 0.35) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Classify frequency based on average interval
  let frequency: RecurringTransaction['frequency'];

  if (avgInterval >= 5 && avgInterval <= 9) {
    frequency = 'weekly';
  } else if (avgInterval >= 12 && avgInterval <= 17) {
    frequency = 'biweekly';
  } else if (avgInterval >= 25 && avgInterval <= 35) {
    frequency = 'monthly';
  } else if (avgInterval >= 80 && avgInterval <= 100) {
    frequency = 'quarterly';
  } else if (avgInterval >= 340 && avgInterval <= 390) {
    frequency = 'annual';
  } else {
    frequency = 'irregular';
  }

  return { frequency, confidence };
}

function calculateMonthlyCost(avgAmount: number, frequency: RecurringTransaction['frequency']): number {
  switch (frequency) {
    case 'weekly':
      return avgAmount * 4.33; // ~4.33 weeks per month
    case 'biweekly':
      return avgAmount * 2.17;
    case 'monthly':
      return avgAmount;
    case 'quarterly':
      return avgAmount / 3;
    case 'annual':
      return avgAmount / 12;
    case 'irregular':
      return avgAmount; // Assume monthly for irregular
    default:
      return avgAmount;
  }
}

function predictNextDate(lastDate: string, avgInterval: number): string | null {
  // Parse lastDate as UTC to avoid timezone inconsistencies
  // YNAB dates are in YYYY-MM-DD format
  const [year, month, day] = lastDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }

  const lastMs = Date.UTC(year, month - 1, day);
  const intervalMs = avgInterval * 24 * 60 * 60 * 1000;
  const nextMs = lastMs + intervalMs;

  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // Only predict if in the future
  if (nextMs > todayMs) {
    return new Date(nextMs).toISOString().split('T')[0] ?? null;
  }

  // If predicted date is in the past, add another interval
  const nextNextMs = nextMs + intervalMs;
  if (nextNextMs > todayMs) {
    return new Date(nextNextMs).toISOString().split('T')[0] ?? null;
  }

  return null;
}
