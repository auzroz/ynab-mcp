/**
 * Get Scheduled Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetScheduledTransaction } from '../../../../src/tools/scheduled-transactions/get-scheduled.js';
import {
  createMockClient,
  createScheduledTransactionResponse,
  mockScheduledTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';
import type { ScheduledTransactionDetail } from 'ynab';

const VALID_ID = '99999999-9999-9999-9999-999999999999';

describe('handleGetScheduledTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns formatted scheduled transaction details', async () => {
    mockClient.getScheduledTransactionById.mockResolvedValue(
      createScheduledTransactionResponse(mockScheduledTransactions[0]!)
    );

    const result = await handleGetScheduledTransaction(
      { scheduled_transaction_id: VALID_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.scheduled_transaction.id).toBe('sched-rent-001');
    expect(parsed.scheduled_transaction.amount).toBe('-$1500.00');
    expect(parsed.scheduled_transaction.frequency).toBe('monthly');
    expect(parsed.scheduled_transaction.subtransactions).toEqual([]);
  });

  it('maps subtransactions when present', async () => {
    const withSubs: ScheduledTransactionDetail = {
      ...mockScheduledTransactions[0]!,
      subtransactions: [
        {
          id: 'sub-1',
          scheduled_transaction_id: 'sched-rent-001',
          amount: -75000,
          memo: 'piece',
          payee_id: 'payee-y',
          payee_name: null,
          category_id: 'cat-y',
          category_name: null,
          transfer_account_id: null,
          deleted: false,
        },
      ],
    };
    mockClient.getScheduledTransactionById.mockResolvedValue(
      createScheduledTransactionResponse(withSubs)
    );

    const result = await handleGetScheduledTransaction(
      { scheduled_transaction_id: VALID_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.scheduled_transaction.subtransactions).toHaveLength(1);
    expect(parsed.scheduled_transaction.subtransactions[0].amount).toBe('-$75.00');
    expect(parsed.scheduled_transaction.subtransactions[0].category_id).toBe('cat-y');
  });

  it('passes budget id and transaction id to client', async () => {
    mockClient.getScheduledTransactionById.mockResolvedValue(
      createScheduledTransactionResponse(mockScheduledTransactions[0]!)
    );

    await handleGetScheduledTransaction(
      { budget_id: 'custom-budget', scheduled_transaction_id: VALID_ID },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
    expect(mockClient.getScheduledTransactionById).toHaveBeenCalledWith('custom-budget', VALID_ID);
  });

  it('throws on invalid (non-uuid) id', async () => {
    await expect(
      handleGetScheduledTransaction({ scheduled_transaction_id: 'not-a-uuid' }, mockClient as never)
    ).rejects.toThrow();
  });
});
