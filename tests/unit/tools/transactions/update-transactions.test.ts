/**
 * Update Transactions (Bulk) Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUpdateTransactions } from '../../../../src/tools/transactions/update-transactions.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const TXN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TXN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';

describe('handleUpdateTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('updates multiple transactions converting amounts', async () => {
    mockClient.updateTransactions.mockResolvedValue({
      data: { transaction_ids: [TXN_A, TXN_B] },
    });

    const result = await handleUpdateTransactions(
      {
        transactions: [
          { id: TXN_A, amount: -42.5 },
          { id: TXN_B, category_id: CATEGORY_ID, cleared: 'cleared' },
        ],
      },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.updateTransactions).toHaveBeenCalledWith('test-budget-id', {
      transactions: [
        { id: TXN_A, amount: -42500 },
        { id: TXN_B, category_id: CATEGORY_ID, cleared: 'cleared' },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.requested_count).toBe(2);
    expect(parsed.updated_count).toBe(2);
    expect(parsed.transaction_ids).toEqual([TXN_A, TXN_B]);
  });

  it('passes all optional fields including null flag_color', async () => {
    mockClient.updateTransactions.mockResolvedValue({
      data: { transaction_ids: [TXN_A] },
    });

    await handleUpdateTransactions(
      {
        transactions: [
          {
            id: TXN_A,
            account_id: '11111111-1111-1111-1111-111111111111',
            date: '2024-03-01',
            payee_name: 'Store',
            memo: 'note',
            approved: false,
            flag_color: null,
          },
        ],
      },
      mockClient as never
    );

    const callArg = mockClient.updateTransactions.mock.calls[0]![1] as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(callArg.transactions[0]).toEqual({
      id: TXN_A,
      account_id: '11111111-1111-1111-1111-111111111111',
      date: '2024-03-01',
      payee_name: 'Store',
      memo: 'note',
      approved: false,
      flag_color: null,
    });
  });

  it('respects budget_id parameter', async () => {
    mockClient.updateTransactions.mockResolvedValue({
      data: { transaction_ids: [TXN_A] },
    });

    await handleUpdateTransactions(
      { budget_id: 'custom-budget', transactions: [{ id: TXN_A, memo: 'x' }] },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
