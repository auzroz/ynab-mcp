/**
 * Income vs Expense Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleIncomeExpense } from '../../../../src/tools/analytics/income-expense.js';
import { createMockClient, createTransactionsResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

function tx(date: string, amount: number, id: string, transfer = false) {
  return {
    id,
    date,
    amount,
    payee_id: 'p',
    payee_name: 'Payee',
    category_id: 'c',
    category_name: 'Cat',
    account_id: 'acct-1',
    transfer_account_id: transfer ? 'acct-2' : null,
    deleted: false,
  };
}

describe('handleIncomeExpense', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('computes income, expenses, net, and savings rate', async () => {
    const txns = [
      tx('2024-01-15', 500000, 'i1'), // $500 income
      tx('2024-01-20', -300000, 'e1'), // $300 expense
      tx('2024-02-15', 500000, 'i2'),
      tx('2024-02-20', -300000, 'e2'),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleIncomeExpense({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.totals.total_income).toBeDefined();
    expect(parsed.totals.total_expenses).toBeDefined();
    expect(parsed.totals.net_savings).toBeDefined();
    // (1000 - 600) / 1000 = 40%
    expect(parsed.totals.savings_rate).toBe('40%');
    expect(parsed.status).toBe('healthy');
    expect(parsed.period.months_analyzed).toBe(2);
    expect(parsed.monthly_breakdown.length).toBe(2);
    expect(parsed.insights.best_month).toBeDefined();
    expect(parsed.insights.worst_month).toBeDefined();
  });

  it('reports concern when spending exceeds income', async () => {
    const txns = [
      tx('2024-01-15', 100000, 'i1'),
      tx('2024-01-20', -300000, 'e1'),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleIncomeExpense({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('concern');
    expect(parsed.message).toBe('Spending exceeds income');
  });

  it('handles no income but expenses (concern)', async () => {
    const txns = [tx('2024-01-20', -300000, 'e1')];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleIncomeExpense({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('concern');
    expect(parsed.message).toBe('No income recorded, but expenses occurred');
    expect(parsed.totals.savings_rate).toBe('N/A');
  });

  it('handles completely empty period (warning)', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));

    const result = await handleIncomeExpense({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('warning');
    expect(parsed.message).toBe('No income or expenses recorded in this period');
    expect(parsed.period.months_analyzed).toBe(0);
    expect(parsed.insights.best_month).toBeNull();
  });

  it('excludes transfers', async () => {
    const txns = [
      tx('2024-01-15', 1000000, 'i1'),
      tx('2024-01-20', -500000, 't1', true), // transfer, excluded
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleIncomeExpense({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Only income should count; no expenses
    expect(parsed.totals.total_expenses).toMatch(/0\.00/);
    expect(parsed.totals.savings_rate).toBe('100%');
  });

  it('detects an improving savings trend', async () => {
    const txns = [
      // first half: low savings
      tx('2024-01-15', 100000, 'i1'),
      tx('2024-01-20', -95000, 'e1'),
      tx('2024-02-15', 100000, 'i2'),
      tx('2024-02-20', -95000, 'e2'),
      // second half: high savings
      tx('2024-03-15', 100000, 'i3'),
      tx('2024-03-20', -20000, 'e3'),
      tx('2024-04-15', 100000, 'i4'),
      tx('2024-04-20', -20000, 'e4'),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleIncomeExpense({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.trend).toBe('improving');
  });

  it('respects months and budget_id parameters', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));

    await handleIncomeExpense({ months: 3, budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
