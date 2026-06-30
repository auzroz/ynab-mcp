/**
 * Cash Flow Forecast Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCashFlowForecast } from '../../../../src/tools/analytics/cash-flow-forecast.js';
import {
  createMockClient,
  createAccountsResponse,
  createScheduledTransactionsResponse,
  mockAllAccounts,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

// Format a Date as a local YYYY-MM-DD string (matches handler's parseLocalDate).
function localDateStr(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Date offset by N days from today (local).
function daysFromNow(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

function scheduled(overrides: {
  id: string;
  date_next: string;
  amount: number;
  frequency?: string;
  payee_name?: string | null;
  deleted?: boolean;
}) {
  return {
    date_first: overrides.date_next,
    frequency: 'never',
    memo: null,
    flag_color: null,
    flag_name: null,
    account_id: 'acct-1',
    account_name: 'Checking',
    payee_id: 'p',
    payee_name: 'Payee',
    category_id: 'c',
    category_name: 'Cat',
    transfer_account_id: null,
    subtransactions: [],
    deleted: false,
    ...overrides,
  };
}

describe('handleCashFlowForecast', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('forecasts cash flow with scheduled income and expenses', async () => {
    const scheds = [
      scheduled({ id: 'inc', date_next: daysFromNow(5), amount: 300000, frequency: 'never', payee_name: 'Employer' }),
      scheduled({ id: 'exp', date_next: daysFromNow(4), amount: -100000, frequency: 'never', payee_name: 'Landlord' }),
    ];
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(scheds as never)
    );

    const result = await handleCashFlowForecast({ days: 30 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toMatch(/healthy|caution|warning/);
    expect(parsed.forecast_period.days).toBe(30);
    expect(parsed.current_position.cash_balance).toBeDefined();
    expect(parsed.current_position.budget_accounts).toBeGreaterThan(0);
    expect(parsed.projected.total_income).toBeDefined();
    expect(parsed.projected.total_expenses).toBeDefined();
    expect(parsed.upcoming_income.length).toBe(1);
    expect(parsed.upcoming_expenses.length).toBe(1);
    expect(parsed.scheduled_transaction_count).toBe(2);
  });

  it('expands recurring scheduled transactions into multiple occurrences', async () => {
    const scheds = [
      scheduled({ id: 'weekly', date_next: daysFromNow(1), amount: -50000, frequency: 'weekly', payee_name: 'Gym' }),
    ];
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(scheds as never)
    );

    const result = await handleCashFlowForecast({ days: 30 }, mockClient as never);
    const parsed = JSON.parse(result);

    // ~30 days / 7 day interval => multiple occurrences
    expect(parsed.scheduled_transaction_count).toBeGreaterThan(1);
  });

  it('handles no scheduled transactions', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse([] as never)
    );

    const result = await handleCashFlowForecast({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.scheduled_transaction_count).toBe(0);
    expect(parsed.status).toBe('healthy');
    expect(parsed.upcoming_expenses).toEqual([]);
    expect(parsed.upcoming_income).toEqual([]);
    expect(parsed.projected.net_change).toMatch(/0\.00/);
  });

  it('reports warning when balance projects negative', async () => {
    // Single small checking account, large scheduled expense.
    const smallAccount = [
      { ...mockAllAccounts[0]!, balance: 50000 }, // $50
    ];
    const scheds = [
      scheduled({ id: 'big', date_next: daysFromNow(3), amount: -200000, frequency: 'never', payee_name: 'Big Bill' }),
    ];
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(smallAccount as never));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(scheds as never)
    );

    const result = await handleCashFlowForecast({ days: 30 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('warning');
    expect(parsed.message).toContain('negative');
  });

  it('excludes deleted and out-of-range scheduled transactions', async () => {
    const scheds = [
      scheduled({ id: 'deleted', date_next: daysFromNow(2), amount: -10000, deleted: true }),
      scheduled({ id: 'far', date_next: daysFromNow(60), amount: -10000, frequency: 'never' }),
      scheduled({ id: 'in-range', date_next: daysFromNow(5), amount: -10000, frequency: 'never' }),
    ];
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(scheds as never)
    );

    const result = await handleCashFlowForecast({ days: 30 }, mockClient as never);
    const parsed = JSON.parse(result);

    // Only the in-range, non-deleted one-time item counts.
    expect(parsed.scheduled_transaction_count).toBe(1);
  });

  it('excludes closed and off-budget accounts from current cash', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse([] as never)
    );

    const result = await handleCashFlowForecast({}, mockClient as never);
    const parsed = JSON.parse(result);

    // mockAllAccounts: 4 budget accounts on_budget + not closed (checking, savings, 2 credit cards)
    expect(parsed.current_position.budget_accounts).toBe(4);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse([] as never)
    );

    await handleCashFlowForecast({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
