/**
 * Cash Flow Forecast Tool
 *
 * Projects future cash flow based on scheduled transactions and spending patterns.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  days: z
    .number()
    .int()
    .min(7)
    .max(90)
    .optional()
    .describe('Number of days to forecast (default 30)'),
});

// Tool definition
export const cashFlowForecastTool: Tool = {
  name: 'ynab_cash_flow_forecast',
  description: `Project future cash flow based on scheduled transactions.

Use when the user asks:
- "What's my cash flow forecast?"
- "Will I have enough money next month?"
- "What bills are coming up?"
- "Project my account balance"
- "When will I run low on money?"

Returns projected cash flow including scheduled income and expenses.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      days: {
        type: 'number',
        description: 'Number of days to forecast (default 30)',
      },
    },
    required: [],
  },
};

interface ScheduledItem {
  date: string;
  payee: string;
  amount: number;
  formatted_amount: string;
  type: 'income' | 'expense';
  frequency: string;
}

interface DailyForecast {
  date: string;
  scheduled_income: number;
  scheduled_expenses: number;
  net_change: number;
  running_balance: number;
}

// Handler function
/**
 * Handler for the ynab_cash_flow_forecast tool.
 */
export async function handleCashFlowForecast(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const forecastDays = validated.days ?? 30;

  // Get accounts and scheduled transactions
  const [accountsResponse, scheduledResponse] = await Promise.all([
    client.getAccounts(budgetId),
    client.getScheduledTransactions(budgetId),
  ]);

  // Calculate current cash position (budget accounts only)
  const budgetAccounts = accountsResponse.data.accounts.filter(
    (a) => a.on_budget && !a.deleted && !a.closed
  );
  const currentCash = sumMilliunits(budgetAccounts.map((a) => a.balance));

  // Set up date range using local dates to avoid UTC offset issues
  // Normalize today to midnight to ensure same-day scheduled items are included
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + forecastDays);

  // Format as local date strings (YYYY-MM-DD)
  const formatLocalDate = (d: Date): string => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const todayStr = formatLocalDate(today);
  const endDateStr = formatLocalDate(endDate);

  // Process scheduled transactions
  const scheduledItems: ScheduledItem[] = [];
  const scheduled = scheduledResponse.data.scheduled_transactions.filter(
    (st) => !st.deleted
  );

  // Frequency mapping
  const frequencyLabels: Record<string, string> = {
    never: 'One-time',
    daily: 'Daily',
    weekly: 'Weekly',
    everyOtherWeek: 'Bi-weekly',
    twiceAMonth: 'Twice monthly',
    every4Weeks: 'Every 4 weeks',
    monthly: 'Monthly',
    everyOtherMonth: 'Every 2 months',
    every3Months: 'Quarterly',
    every4Months: 'Every 4 months',
    twiceAYear: 'Twice yearly',
    yearly: 'Yearly',
    everyOtherYear: 'Every 2 years',
  };

  // Helper to parse YYYY-MM-DD as local date
  const parseLocalDate = (dateStr: string): Date => {
    // Validate format before parsing
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Invalid date format in scheduled transaction');
    }
    const parts = dateStr.split('-').map(Number) as [number, number, number];
    const [year, month, day] = parts;
    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      throw new Error('Invalid date values in scheduled transaction');
    }
    const date = new Date(year, month - 1, day);
    // Verify date components match input (catches rollover from invalid values like month 99)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error('Invalid date values in scheduled transaction');
    }
    return date;
  };

  // Generate occurrences for each scheduled transaction
  for (const st of scheduled) {
    const nextDate = parseLocalDate(st.date_next);
    if (nextDate > endDate) continue;

    // Add first occurrence if in range
    if (nextDate >= today && nextDate <= endDate) {
      const freqStr = String(st.frequency);
      scheduledItems.push({
        date: st.date_next,
        payee: sanitizeName(st.payee_name),
        amount: st.amount,
        formatted_amount: formatCurrency(st.amount),
        type: st.amount >= 0 ? 'income' : 'expense',
        frequency: frequencyLabels[freqStr] ?? freqStr,
      });
    }

    // For recurring transactions, calculate additional occurrences
    if (String(st.frequency) !== 'never') {
      let currentDate = parseLocalDate(st.date_next);
      const intervalDays = getIntervalDays(String(st.frequency));

      if (intervalDays > 0) {
        // Calculate max possible occurrences based on forecast period and interval
        const maxOccurrences = Math.ceil(forecastDays / intervalDays) + 1;
        for (let i = 0; i < maxOccurrences; i++) {
          currentDate = new Date(currentDate);
          currentDate.setDate(currentDate.getDate() + intervalDays);

          if (currentDate > endDate) break;
          if (currentDate < today) continue;

          const freqStr = String(st.frequency);
          scheduledItems.push({
            date: formatLocalDate(currentDate),
            payee: sanitizeName(st.payee_name),
            amount: st.amount,
            formatted_amount: formatCurrency(st.amount),
            type: st.amount >= 0 ? 'income' : 'expense',
            frequency: frequencyLabels[freqStr] ?? freqStr,
          });
        }
      }
    }
  }

  // Sort by date
  scheduledItems.sort((a, b) => a.date.localeCompare(b.date));

  // Build daily forecast
  const dailyForecasts: DailyForecast[] = [];
  let runningBalance = currentCash;

  // Group scheduled items by date
  const itemsByDate = new Map<string, ScheduledItem[]>();
  for (const item of scheduledItems) {
    if (!itemsByDate.has(item.date)) {
      itemsByDate.set(item.date, []);
    }
    itemsByDate.get(item.date)!.push(item);
  }

  // Generate daily forecast
  const currentDate = new Date(today);
  while (currentDate <= endDate) {
    const dateStr = formatLocalDate(currentDate);
    const items = itemsByDate.get(dateStr) ?? [];

    const scheduledIncome = sumMilliunits(
      items.filter((i) => i.type === 'income').map((i) => i.amount)
    );
    const scheduledExpenses = sumMilliunits(
      items.filter((i) => i.type === 'expense').map((i) => Math.abs(i.amount))
    );
    const netChange = scheduledIncome - scheduledExpenses;

    runningBalance += netChange;

    // Only include days with activity or key milestone days
    if (items.length > 0 || currentDate.getDate() === 1 || currentDate.getDate() === 15) {
      dailyForecasts.push({
        date: dateStr,
        scheduled_income: scheduledIncome,
        scheduled_expenses: scheduledExpenses,
        net_change: netChange,
        running_balance: runningBalance,
      });
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Calculate totals
  const totalScheduledIncome = sumMilliunits(
    scheduledItems.filter((i) => i.type === 'income').map((i) => i.amount)
  );
  const totalScheduledExpenses = sumMilliunits(
    scheduledItems.filter((i) => i.type === 'expense').map((i) => Math.abs(i.amount))
  );
  const netProjectedChange = totalScheduledIncome - totalScheduledExpenses;
  const projectedEndBalance = currentCash + netProjectedChange;

  // Find low point
  let lowestBalance = currentCash;
  let lowestBalanceDate = todayStr;
  let tempBalance = currentCash;

  for (const forecast of dailyForecasts) {
    tempBalance = forecast.running_balance;
    if (tempBalance < lowestBalance) {
      lowestBalance = tempBalance;
      lowestBalanceDate = forecast.date;
    }
  }

  // Determine status
  let status: 'healthy' | 'caution' | 'warning';
  let message: string;

  if (lowestBalance < 0) {
    status = 'warning';
    message = `Projected to go negative (${formatCurrency(lowestBalance)}) on ${lowestBalanceDate}`;
  } else if (lowestBalance < currentCash * 0.2) {
    status = 'caution';
    message = `Balance may drop to ${formatCurrency(lowestBalance)} on ${lowestBalanceDate}`;
  } else {
    status = 'healthy';
    message = 'Cash flow looks healthy for the forecast period';
  }

  // Upcoming expenses (next 7 days)
  const upcomingDate = new Date(today);
  upcomingDate.setDate(upcomingDate.getDate() + 7);
  const upcomingExpenses = scheduledItems
    .filter((i) => i.type === 'expense' && i.date <= formatLocalDate(upcomingDate))
    .slice(0, 10);

  // Upcoming income
  const upcomingIncome = scheduledItems
    .filter((i) => i.type === 'income')
    .slice(0, 5);

  return JSON.stringify(
    {
      status,
      message,
      forecast_period: {
        start: todayStr,
        end: endDateStr,
        days: forecastDays,
      },
      current_position: {
        cash_balance: formatCurrency(currentCash),
        budget_accounts: budgetAccounts.length,
      },
      projected: {
        end_balance: formatCurrency(projectedEndBalance),
        total_income: formatCurrency(totalScheduledIncome),
        total_expenses: formatCurrency(totalScheduledExpenses),
        net_change: formatCurrency(netProjectedChange),
        lowest_balance: formatCurrency(lowestBalance),
        lowest_balance_date: lowestBalanceDate,
      },
      upcoming_expenses: upcomingExpenses.map((e) => ({
        date: e.date,
        payee: e.payee,
        amount: e.formatted_amount,
        frequency: e.frequency,
      })),
      upcoming_income: upcomingIncome.map((i) => ({
        date: i.date,
        payee: i.payee,
        amount: i.formatted_amount,
        frequency: i.frequency,
      })),
      daily_forecast: dailyForecasts.slice(0, 15).map((d) => ({
        date: d.date,
        income: formatCurrency(d.scheduled_income),
        expenses: formatCurrency(d.scheduled_expenses),
        balance: formatCurrency(d.running_balance),
      })),
      scheduled_transaction_count: scheduledItems.length,
    },
    null,
    2
  );
}

/**
 * Get approximate interval in days for a recurring frequency.
 *
 * Note: These are approximations using fixed day counts. For example:
 * - "monthly" uses 30 days, which causes slight drift over time
 * - "twiceAMonth" uses 15 days, which doesn't match actual 1st/15th patterns
 * - "yearly" uses 365 days, which doesn't account for leap years
 *
 * For short forecast periods (30-90 days), this approximation is acceptable.
 * For longer periods, the actual scheduled transaction dates from YNAB
 * should be used instead.
 */
function getIntervalDays(frequency: string): number {
  switch (frequency) {
    case 'daily':
      return 1;
    case 'weekly':
      return 7;
    case 'everyOtherWeek':
      return 14;
    case 'twiceAMonth':
      return 15;
    case 'every4Weeks':
      return 28;
    case 'monthly':
      return 30;
    case 'everyOtherMonth':
      return 60;
    case 'every3Months':
      return 90;
    case 'every4Months':
      return 120;
    case 'twiceAYear':
      return 180;
    case 'yearly':
      return 365;
    case 'everyOtherYear':
      return 730;
    default:
      return 0;
  }
}
