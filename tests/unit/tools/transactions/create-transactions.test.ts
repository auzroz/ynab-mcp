/**
 * Create Transactions (Bulk) Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateTransactions } from '../../../../src/tools/transactions/create-transactions.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function bulkResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      transactions: [
        {
          id: 'bulk-001',
          date: '2024-02-01',
          amount: -42500,
          payee_name: 'Amazon',
          category_name: 'Shopping',
        },
        {
          id: 'bulk-002',
          date: '2024-02-02',
          amount: -10000,
          payee_name: 'Target',
          category_name: 'Shopping',
        },
      ],
      duplicate_import_ids: [],
      ...overrides,
    },
  };
}

describe('handleCreateTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates multiple transactions converting dollars to milliunits', async () => {
    mockClient.createTransaction.mockResolvedValue(bulkResponse());

    const result = await handleCreateTransactions(
      {
        transactions: [
          { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -42.5 },
          { account_id: ACCOUNT_ID, date: '2024-02-02', amount: -10, import_id: 'imp-1' },
        ],
      },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.createTransaction).toHaveBeenCalledWith('test-budget-id', {
      transactions: [
        { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -42500 },
        { account_id: ACCOUNT_ID, date: '2024-02-02', amount: -10000, import_id: 'imp-1' },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.summary.created_count).toBe(2);
    expect(parsed.transactions.length).toBe(2);
  });

  it('reports duplicate import ids', async () => {
    mockClient.createTransaction.mockResolvedValue(
      bulkResponse({ transactions: [], duplicate_import_ids: ['dup-1', 'dup-2'] })
    );

    const result = await handleCreateTransactions(
      { transactions: [{ account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1 }] },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.summary.created_count).toBe(0);
    expect(parsed.summary.duplicate_count).toBe(2);
    expect(parsed.summary.total_amount).toBe('$0.00');
    expect(parsed.duplicate_import_ids).toEqual(['dup-1', 'dup-2']);
  });

  it('passes optional per-transaction fields', async () => {
    mockClient.createTransaction.mockResolvedValue(bulkResponse());

    await handleCreateTransactions(
      {
        transactions: [
          {
            account_id: ACCOUNT_ID,
            date: '2024-02-01',
            amount: 25,
            payee_name: 'Store',
            memo: 'note',
            cleared: 'cleared',
            approved: true,
            flag_color: 'green',
          },
        ],
      },
      mockClient as never
    );

    const callArg = mockClient.createTransaction.mock.calls[0]![1] as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(callArg.transactions[0]).toEqual({
      account_id: ACCOUNT_ID,
      date: '2024-02-01',
      amount: 25000,
      payee_name: 'Store',
      memo: 'note',
      cleared: 'cleared',
      approved: true,
      flag_color: 'green',
    });
  });

  it('respects budget_id parameter', async () => {
    mockClient.createTransaction.mockResolvedValue(bulkResponse());

    await handleCreateTransactions(
      {
        budget_id: 'custom-budget',
        transactions: [{ account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1 }],
      },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
