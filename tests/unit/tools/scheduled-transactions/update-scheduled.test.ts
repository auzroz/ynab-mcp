/**
 * Update Scheduled Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUpdateScheduledTransaction } from '../../../../src/tools/scheduled-transactions/update-scheduled.js';
import {
  createMockClient,
  createScheduledTransactionResponse,
  mockScheduledTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const SCHEDULED_ID = '99999999-9999-9999-9999-999999999999';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const PAYEE_ID = '22222222-2222-2222-2222-222222222222';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';
const FUTURE_DATE = '2027-01-01';

describe('handleUpdateScheduledTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.updateScheduledTransaction.mockResolvedValue(
      createScheduledTransactionResponse(mockScheduledTransactions[0]!)
    );
  });

  it('updates amount with dollars converted to milliunits', async () => {
    const result = await handleUpdateScheduledTransaction(
      { scheduled_transaction_id: SCHEDULED_ID, amount: -75.25 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(mockClient.updateScheduledTransaction).toHaveBeenCalledTimes(1);
    const [budgetId, id, body] = mockClient.updateScheduledTransaction.mock.calls[0]!;
    expect(budgetId).toBe('test-budget-id');
    expect(id).toBe(SCHEDULED_ID);
    expect(body.scheduled_transaction).toEqual({ amount: -75250 });
  });

  it('updates all provided fields and respects budget_id', async () => {
    await handleUpdateScheduledTransaction(
      {
        budget_id: 'custom-budget',
        scheduled_transaction_id: SCHEDULED_ID,
        account_id: ACCOUNT_ID,
        date: FUTURE_DATE,
        amount: 12.5,
        frequency: 'weekly',
        payee_id: PAYEE_ID,
        payee_name: 'New Name',
        category_id: CATEGORY_ID,
        memo: 'updated memo',
        flag_color: 'blue',
      },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
    const body = mockClient.updateScheduledTransaction.mock.calls[0]![2];
    expect(body.scheduled_transaction).toMatchObject({
      account_id: ACCOUNT_ID,
      date: FUTURE_DATE,
      amount: 12500,
      frequency: 'weekly',
      payee_id: PAYEE_ID,
      payee_name: 'New Name',
      category_id: CATEGORY_ID,
      memo: 'updated memo',
      flag_color: 'blue',
    });
  });

  it('allows clearing the flag with null', async () => {
    await handleUpdateScheduledTransaction(
      { scheduled_transaction_id: SCHEDULED_ID, flag_color: null },
      mockClient as never
    );

    const body = mockClient.updateScheduledTransaction.mock.calls[0]![2];
    expect(body.scheduled_transaction.flag_color).toBeNull();
  });

  it('returns error when no fields are provided to update', async () => {
    const result = await handleUpdateScheduledTransaction(
      { scheduled_transaction_id: SCHEDULED_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('No fields provided to update');
    expect(mockClient.updateScheduledTransaction).not.toHaveBeenCalled();
  });

  it('returns error JSON without calling client when date is invalid', async () => {
    const result = await handleUpdateScheduledTransaction(
      { scheduled_transaction_id: SCHEDULED_ID, date: '2020-01-01' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Date must be in the future');
    expect(mockClient.updateScheduledTransaction).not.toHaveBeenCalled();
  });
});
