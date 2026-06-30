/**
 * Spending by Payee Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSpendingByPayee } from '../../../../src/tools/analytics/spending-by-payee.js';
import {
  createMockClient,
  createTransactionsResponse,
  mockAllTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

function tx(overrides: {
  id: string;
  date: string;
  amount: number;
  payee_name?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
}) {
  return {
    payee_id: 'p',
    category_id: 'c',
    account_id: 'acct-1',
    payee_name: 'Payee',
    category_name: 'Cat',
    transfer_account_id: null,
    deleted: false,
    ...overrides,
  };
}

describe('handleSpendingByPayee', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('ranks payees by total spending', async () => {
    const txns = [
      tx({ id: 'a1', date: '2024-01-01', amount: -50000, payee_name: 'Amazon', category_name: 'Shopping' }),
      tx({ id: 'a2', date: '2024-01-15', amount: -50000, payee_name: 'Amazon', category_name: 'Shopping' }),
      tx({ id: 'b1', date: '2024-01-05', amount: -20000, payee_name: 'Kroger', category_name: 'Groceries' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleSpendingByPayee({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.top_payees[0].payee).toBe('Amazon');
    expect(parsed.top_payees[0].transactions).toBe(2);
    expect(parsed.top_payees[0].category).toBe('Shopping');
    expect(parsed.summary.unique_payees).toBe(2);
    expect(parsed.summary.transaction_count).toBe(3);
    expect(parsed.insights.highest_spender).toBe('Amazon');
    expect(parsed.insights.most_frequent).toBe('Amazon');
  });

  it('respects the limit parameter', async () => {
    const txns = [
      tx({ id: '1', date: '2024-01-01', amount: -50000, payee_name: 'A' }),
      tx({ id: '2', date: '2024-01-01', amount: -40000, payee_name: 'B' }),
      tx({ id: '3', date: '2024-01-01', amount: -30000, payee_name: 'C' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleSpendingByPayee({ limit: 2 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.top_payees.length).toBe(2);
    expect(parsed.summary.payees_shown).toBe(2);
    expect(parsed.summary.unique_payees).toBe(3);
  });

  it('respects min_transactions filter', async () => {
    const txns = [
      tx({ id: '1', date: '2024-01-01', amount: -50000, payee_name: 'Frequent' }),
      tx({ id: '2', date: '2024-01-10', amount: -50000, payee_name: 'Frequent' }),
      tx({ id: '3', date: '2024-01-15', amount: -90000, payee_name: 'OneOff' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleSpendingByPayee({ min_transactions: 2 }, mockClient as never);
    const parsed = JSON.parse(result);

    const names = parsed.top_payees.map((p: { payee: string }) => p.payee);
    expect(names).toContain('Frequent');
    expect(names).not.toContain('OneOff');
  });

  it('excludes transfers and inflows', async () => {
    const txns = [
      tx({ id: 'out', date: '2024-01-01', amount: -50000, payee_name: 'Store' }),
      tx({ id: 'in', date: '2024-01-02', amount: 100000, payee_name: 'Employer' }),
      tx({ id: 'xfer', date: '2024-01-03', amount: -25000, payee_name: 'Transfer : Savings', transfer_account_id: 'acct-2' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(txns as never));

    const result = await handleSpendingByPayee({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.transaction_count).toBe(1);
    expect(parsed.top_payees.length).toBe(1);
    expect(parsed.top_payees[0].payee).toBe('Store');
  });

  it('handles empty transactions', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));

    const result = await handleSpendingByPayee({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.top_payees).toEqual([]);
    expect(parsed.summary.unique_payees).toBe(0);
    expect(parsed.summary.top_5_concentration).toBe('0%');
    expect(parsed.insights.highest_spender).toBeNull();
    expect(parsed.insights.most_frequent).toBeNull();
    expect(parsed.insights.highest_average).toBeNull();
  });

  it('works with the full fixture transaction set', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));

    const result = await handleSpendingByPayee({ months: 6 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.period.months_analyzed).toBe(6);
    expect(parsed.top_payees.length).toBeGreaterThan(0);
  });

  it('respects budget_id parameter', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));

    await handleSpendingByPayee({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
