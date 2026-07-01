/**
 * Delete Scheduled Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleDeleteScheduledTransaction } from '../../../../src/tools/scheduled-transactions/delete-scheduled.js';
import {
  createMockClient,
  createScheduledTransactionResponse,
  mockScheduledTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const SCHEDULED_ID = '99999999-9999-9999-9999-999999999999';

describe('handleDeleteScheduledTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.deleteScheduledTransaction.mockResolvedValue(
      createScheduledTransactionResponse(mockScheduledTransactions[0]!)
    );
  });

  it('deletes a scheduled transaction and returns success details', async () => {
    const result = await handleDeleteScheduledTransaction(
      { scheduled_transaction_id: SCHEDULED_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('-$1500.00');
    expect(parsed.deleted_scheduled_transaction.id).toBe('sched-rent-001');
    expect(parsed.deleted_scheduled_transaction.amount).toBe('-$1500.00');
    expect(mockClient.deleteScheduledTransaction).toHaveBeenCalledWith(
      'test-budget-id',
      SCHEDULED_ID
    );
  });

  it('respects budget_id parameter', async () => {
    await handleDeleteScheduledTransaction(
      { budget_id: 'custom-budget', scheduled_transaction_id: SCHEDULED_ID },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
    expect(mockClient.deleteScheduledTransaction).toHaveBeenCalledWith('custom-budget', SCHEDULED_ID);
  });

  it('throws on invalid (non-uuid) id', async () => {
    await expect(
      handleDeleteScheduledTransaction(
        { scheduled_transaction_id: 'not-a-uuid' },
        mockClient as never
      )
    ).rejects.toThrow();
    expect(mockClient.deleteScheduledTransaction).not.toHaveBeenCalled();
  });
});
