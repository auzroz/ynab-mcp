/**
 * Create Scheduled Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateScheduledTransaction } from '../../../../src/tools/scheduled-transactions/create-scheduled.js';
import {
  createMockClient,
  createScheduledTransactionResponse,
  mockScheduledTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const PAYEE_ID = '22222222-2222-2222-2222-222222222222';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';
// Far-future date (test current date is 2026-06-30)
const FUTURE_DATE = '2027-01-01';

describe('handleCreateScheduledTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.createScheduledTransaction.mockResolvedValue(
      createScheduledTransactionResponse(mockScheduledTransactions[0]!)
    );
  });

  it('creates a scheduled transaction with dollars converted to milliunits', async () => {
    const result = await handleCreateScheduledTransaction(
      {
        account_id: ACCOUNT_ID,
        date: FUTURE_DATE,
        amount: -50.0,
        frequency: 'monthly',
        payee_name: 'New Payee',
      },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(mockClient.createScheduledTransaction).toHaveBeenCalledTimes(1);
    const [budgetId, body] = mockClient.createScheduledTransaction.mock.calls[0]!;
    expect(budgetId).toBe('test-budget-id');
    expect(body.scheduled_transaction).toMatchObject({
      account_id: ACCOUNT_ID,
      date: FUTURE_DATE,
      amount: -50000, // dollars -> milliunits
      frequency: 'monthly',
      payee_name: 'New Payee',
    });
    expect(parsed.scheduled_transaction.id).toBeDefined();
  });

  it('includes all optional fields when provided', async () => {
    await handleCreateScheduledTransaction(
      {
        budget_id: 'custom-budget',
        account_id: ACCOUNT_ID,
        date: FUTURE_DATE,
        amount: 100.5,
        frequency: 'weekly',
        payee_id: PAYEE_ID,
        payee_name: 'Payee Name',
        category_id: CATEGORY_ID,
        memo: 'a memo',
        flag_color: 'red',
      },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
    const body = mockClient.createScheduledTransaction.mock.calls[0]![1];
    expect(body.scheduled_transaction).toMatchObject({
      amount: 100500,
      payee_id: PAYEE_ID,
      payee_name: 'Payee Name',
      category_id: CATEGORY_ID,
      memo: 'a memo',
      flag_color: 'red',
    });
  });

  it('omits optional fields that are not provided', async () => {
    await handleCreateScheduledTransaction(
      {
        account_id: ACCOUNT_ID,
        date: FUTURE_DATE,
        amount: -10,
        frequency: 'monthly',
        payee_id: PAYEE_ID,
      },
      mockClient as never
    );

    const body = mockClient.createScheduledTransaction.mock.calls[0]![1];
    expect(body.scheduled_transaction.memo).toBeUndefined();
    expect(body.scheduled_transaction.category_id).toBeUndefined();
    expect(body.scheduled_transaction.flag_color).toBeUndefined();
    expect(body.scheduled_transaction.payee_name).toBeUndefined();
  });

  it('returns error JSON without calling client when date is in the past', async () => {
    const result = await handleCreateScheduledTransaction(
      {
        account_id: ACCOUNT_ID,
        date: '2020-01-01',
        amount: -50,
        frequency: 'monthly',
        payee_name: 'New Payee',
      },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Date must be in the future');
    expect(mockClient.createScheduledTransaction).not.toHaveBeenCalled();
  });

  it('throws when neither payee_id nor payee_name is provided', async () => {
    await expect(
      handleCreateScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          date: FUTURE_DATE,
          amount: -50,
          frequency: 'monthly',
        },
        mockClient as never
      )
    ).rejects.toThrow();
    expect(mockClient.createScheduledTransaction).not.toHaveBeenCalled();
  });
});
