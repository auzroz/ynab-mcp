/**
 * List Scheduled Transactions Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListScheduledTransactions } from '../../../../src/tools/scheduled-transactions/list-scheduled.js';
import {
  createMockClient,
  createScheduledTransactionsResponse,
  mockScheduledTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';
import type { ScheduledTransactionDetail } from 'ynab';

describe('handleListScheduledTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists active scheduled transactions sorted by next date', async () => {
    mockClient.getScheduledTransactions.mockResolvedValue(createScheduledTransactionsResponse());

    const result = await handleListScheduledTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.scheduled_transactions).toBeInstanceOf(Array);
    expect(parsed.scheduled_transactions).toHaveLength(mockScheduledTransactions.length);
    expect(parsed.summary.total_count).toBe(mockScheduledTransactions.length);

    // Sorted ascending by date_next
    const dates = parsed.scheduled_transactions.map((t: { date_next: string }) => t.date_next);
    expect(dates).toEqual([...dates].sort((a, b) => a.localeCompare(b)));
  });

  it('formats amounts as currency and includes summary fields', async () => {
    mockClient.getScheduledTransactions.mockResolvedValue(createScheduledTransactionsResponse());

    const result = await handleListScheduledTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    const rent = parsed.scheduled_transactions.find((t: { id: string }) => t.id === 'sched-rent-001');
    expect(rent.amount).toBe('-$1500.00');
    expect(parsed.summary.estimated_monthly_total).toMatch(/^\$/);
    expect(parsed.summary.by_frequency).toBeDefined();
    expect(parsed.summary.by_frequency.monthly).toBe(2);
    expect(parsed.summary.by_frequency.twiceAMonth).toBe(1);
  });

  it('filters out deleted scheduled transactions', async () => {
    const withDeleted: ScheduledTransactionDetail[] = [
      ...mockScheduledTransactions,
      { ...mockScheduledTransactions[0]!, id: 'sched-deleted', deleted: true },
    ];
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(withDeleted)
    );

    const result = await handleListScheduledTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    const ids = parsed.scheduled_transactions.map((t: { id: string }) => t.id);
    expect(ids).not.toContain('sched-deleted');
    expect(parsed.summary.total_count).toBe(mockScheduledTransactions.length);
  });

  it('maps subtransactions when present', async () => {
    const withSubs: ScheduledTransactionDetail[] = [
      {
        ...mockScheduledTransactions[0]!,
        id: 'sched-split',
        subtransactions: [
          {
            id: 'sub-1',
            scheduled_transaction_id: 'sched-split',
            amount: -50000,
            memo: 'part one',
            payee_id: 'payee-x',
            payee_name: null,
            category_id: 'cat-x',
            category_name: null,
            transfer_account_id: null,
            deleted: false,
          },
        ],
      },
    ];
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(withSubs)
    );

    const result = await handleListScheduledTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    const split = parsed.scheduled_transactions[0];
    expect(split.subtransactions).toHaveLength(1);
    expect(split.subtransactions[0].amount).toBe('-$50.00');
    expect(split.subtransactions[0].payee_id).toBe('payee-x');
  });

  it('covers all frequency branches for monthly estimate', async () => {
    const frequencies = [
      'daily',
      'weekly',
      'everyOtherWeek',
      'twiceAMonth',
      'every4Weeks',
      'monthly',
      'everyOtherMonth',
      'every3Months',
      'every4Months',
      'twiceAYear',
      'yearly',
      'everyOtherYear',
      'never',
    ];
    const txns: ScheduledTransactionDetail[] = frequencies.map((freq, i) => ({
      ...mockScheduledTransactions[0]!,
      id: `sched-freq-${i}`,
      frequency: freq as ScheduledTransactionDetail['frequency'],
      amount: -120000,
    }));
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse(txns)
    );

    const result = await handleListScheduledTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_count).toBe(frequencies.length);
    expect(parsed.summary.estimated_monthly_total).toMatch(/^\$/);
  });

  it('handles empty list', async () => {
    mockClient.getScheduledTransactions.mockResolvedValue(createScheduledTransactionsResponse([]));

    const result = await handleListScheduledTransactions({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.scheduled_transactions).toHaveLength(0);
    expect(parsed.summary.total_count).toBe(0);
    expect(parsed.summary.estimated_monthly_total).toBe('$0.00');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getScheduledTransactions.mockResolvedValue(createScheduledTransactionsResponse());

    await handleListScheduledTransactions({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
    expect(mockClient.getScheduledTransactions).toHaveBeenCalledWith('custom-budget');
  });
});
