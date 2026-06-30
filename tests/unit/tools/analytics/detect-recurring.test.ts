/**
 * Detect Recurring Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleDetectRecurring } from '../../../../src/tools/analytics/detect-recurring.js';
import { createMockClient, createTransactionsResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

// Build a transaction object with the fields the handler reads.
function txn(overrides: {
  id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  account_id?: string;
  transfer_account_id?: string | null;
  deleted?: boolean;
}) {
  return {
    account_id: 'acct-1',
    payee_id: 'payee-1',
    payee_name: 'Test Payee',
    category_id: 'cat-1',
    category_name: 'Test Category',
    transfer_account_id: null,
    deleted: false,
    ...overrides,
  };
}

// Generate a monthly (every ~30 days) recurring pattern for a payee.
function monthlyPattern(
  payeeId: string,
  payeeName: string,
  amount: number,
  count: number
) {
  const txns = [];
  for (let i = 0; i < count; i++) {
    const month = String(i + 1).padStart(2, '0');
    txns.push(
      txn({
        id: `${payeeId}-${i}`,
        date: `2024-${month}-15`,
        amount,
        payee_id: payeeId,
        payee_name: payeeName,
        category_id: 'cat-subs',
        category_name: 'Subscriptions',
      })
    );
  }
  return txns;
}

describe('handleDetectRecurring', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('detects a monthly recurring pattern', async () => {
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse(monthlyPattern('payee-netflix', 'Netflix', -15990, 5) as never)
    );

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recurring_transactions.length).toBe(1);
    const r = parsed.recurring_transactions[0];
    expect(r.payee_name).toBe('Netflix');
    expect(r.frequency).toBe('monthly');
    expect(r.occurrence_count).toBe(5);
    expect(r.confidence).toBe('high');
    expect(r.can_convert).toBe(true);
    expect(r.suggested_frequency).toBe('monthly');
    expect(parsed.summary.total_recurring_found).toBe(1);
    expect(parsed.summary.high_confidence_count).toBe(1);
    expect(parsed.by_frequency.monthly).toBe(1);
  });

  it('detects a weekly recurring pattern with conversion fields', async () => {
    const weekly = [
      txn({ id: 'w-1', date: '2024-01-01', amount: -5000, payee_id: 'p-coffee', payee_name: 'Coffee Shop', category_id: 'c1', category_name: 'Coffee' }),
      txn({ id: 'w-2', date: '2024-01-08', amount: -5000, payee_id: 'p-coffee', payee_name: 'Coffee Shop', category_id: 'c1', category_name: 'Coffee' }),
      txn({ id: 'w-3', date: '2024-01-15', amount: -5000, payee_id: 'p-coffee', payee_name: 'Coffee Shop', category_id: 'c1', category_name: 'Coffee' }),
      txn({ id: 'w-4', date: '2024-01-22', amount: -5000, payee_id: 'p-coffee', payee_name: 'Coffee Shop', category_id: 'c1', category_name: 'Coffee' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(weekly as never));

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recurring_transactions.length).toBe(1);
    const r = parsed.recurring_transactions[0];
    expect(r.frequency).toBe('weekly');
    expect(r.suggested_frequency).toBe('weekly');
    expect(parsed.by_frequency.weekly).toBe(1);
  });

  it('returns nothing when payees have too few occurrences', async () => {
    const few = [
      txn({ id: 'a', date: '2024-01-01', amount: -1000, payee_id: 'p1', payee_name: 'P1' }),
      txn({ id: 'b', date: '2024-02-01', amount: -1000, payee_id: 'p1', payee_name: 'P1' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(few as never));

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    // min_occurrences defaults to 3, so 2 transactions are skipped
    expect(parsed.recurring_transactions.length).toBe(0);
    expect(parsed.summary.total_recurring_found).toBe(0);
  });

  it('respects min_occurrences parameter', async () => {
    const two = [
      txn({ id: 'a', date: '2024-01-15', amount: -1000, payee_id: 'p1', payee_name: 'P1' }),
      txn({ id: 'b', date: '2024-02-15', amount: -1000, payee_id: 'p1', payee_name: 'P1' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(two as never));

    const result = await handleDetectRecurring({ min_occurrences: 2 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recurring_transactions.length).toBe(1);
    expect(parsed.recurring_transactions[0].frequency).toBe('monthly');
  });

  it('skips transactions without a payee_id', async () => {
    const noPayee = [
      txn({ id: 'a', date: '2024-01-15', amount: -1000, payee_id: null, payee_name: 'No ID' }),
      txn({ id: 'b', date: '2024-02-15', amount: -1000, payee_id: null, payee_name: 'No ID' }),
      txn({ id: 'c', date: '2024-03-15', amount: -1000, payee_id: null, payee_name: 'No ID' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(noPayee as never));

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recurring_transactions.length).toBe(0);
  });

  it('excludes transfers and inflows', async () => {
    const mixed = [
      ...monthlyPattern('p-real', 'Real Sub', -2000, 4),
      txn({ id: 't1', date: '2024-01-10', amount: -500, payee_id: 'p-x', payee_name: 'X', transfer_account_id: 'acct-2' }),
      txn({ id: 't2', date: '2024-02-10', amount: -500, payee_id: 'p-x', payee_name: 'X', transfer_account_id: 'acct-2' }),
      txn({ id: 't3', date: '2024-03-10', amount: -500, payee_id: 'p-x', payee_name: 'X', transfer_account_id: 'acct-2' }),
      txn({ id: 'in1', date: '2024-01-05', amount: 3000, payee_id: 'p-emp', payee_name: 'Employer' }),
      txn({ id: 'in2', date: '2024-02-05', amount: 3000, payee_id: 'p-emp', payee_name: 'Employer' }),
      txn({ id: 'in3', date: '2024-03-05', amount: 3000, payee_id: 'p-emp', payee_name: 'Employer' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(mixed as never));

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Only the real outflow subscription should be detected
    expect(parsed.recurring_transactions.length).toBe(1);
    expect(parsed.recurring_transactions[0].payee_name).toBe('Real Sub');
  });

  it('handles empty transaction list', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recurring_transactions).toEqual([]);
    expect(parsed.summary.total_recurring_found).toBe(0);
  });

  it('respects months parameter in summary', async () => {
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse(monthlyPattern('p1', 'P1', -1000, 4) as never)
    );

    const result = await handleDetectRecurring({ months: 12 }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.analysis_period).toBe('12 months');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([] as never));

    await handleDetectRecurring({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });

  it('detects a quarterly pattern (medium/high confidence path)', async () => {
    const quarterly = [
      txn({ id: 'q1', date: '2024-01-15', amount: -30000, payee_id: 'p-ins', payee_name: 'Insurance', category_id: 'c', category_name: 'Insurance' }),
      txn({ id: 'q2', date: '2024-04-15', amount: -30000, payee_id: 'p-ins', payee_name: 'Insurance', category_id: 'c', category_name: 'Insurance' }),
      txn({ id: 'q3', date: '2024-07-15', amount: -30000, payee_id: 'p-ins', payee_name: 'Insurance', category_id: 'c', category_name: 'Insurance' }),
    ];
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse(quarterly as never));

    const result = await handleDetectRecurring({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recurring_transactions.length).toBe(1);
    expect(parsed.recurring_transactions[0].frequency).toBe('quarterly');
    expect(parsed.recurring_transactions[0].suggested_frequency).toBe('every3Months');
    expect(parsed.by_frequency.quarterly).toBe(1);
  });
});
