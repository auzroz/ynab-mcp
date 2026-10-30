/**
 * Create Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateTransaction } from '../../../../src/tools/transactions/create-transaction.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const PAYEE_ID = '22222222-2222-2222-2222-222222222222';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';

function createdTxnResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      transaction: {
        id: 'new-txn-001',
        date: '2024-02-01',
        amount: -42500,
        payee_name: 'Amazon',
        category_name: 'Shopping',
        account_name: 'Primary Checking',
        memo: 'Test purchase',
        cleared: 'uncleared',
        approved: true,
        ...overrides,
      },
    },
  };
}

describe('handleCreateTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates a transaction converting dollars to milliunits', async () => {
    mockClient.createTransaction.mockResolvedValue(createdTxnResponse());

    const result = await handleCreateTransaction(
      { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -42.5 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.createTransaction).toHaveBeenCalledWith('test-budget-id', {
      transaction: {
        account_id: ACCOUNT_ID,
        date: '2024-02-01',
        amount: -42500,
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.transaction.id).toBe('new-txn-001');
    expect(parsed.message).toContain('-$42.50');
  });

  it('includes all optional fields in the client call', async () => {
    mockClient.createTransaction.mockResolvedValue(createdTxnResponse());

    await handleCreateTransaction(
      {
        account_id: ACCOUNT_ID,
        date: '2024-02-01',
        amount: -100,
        payee_id: PAYEE_ID,
        category_id: CATEGORY_ID,
        memo: 'Test purchase',
        cleared: 'cleared',
        approved: true,
        flag_color: 'red',
      },
      mockClient as never
    );

    expect(mockClient.createTransaction).toHaveBeenCalledWith('test-budget-id', {
      transaction: {
        account_id: ACCOUNT_ID,
        date: '2024-02-01',
        amount: -100000,
        payee_id: PAYEE_ID,
        category_id: CATEGORY_ID,
        memo: 'Test purchase',
        cleared: 'cleared',
        approved: true,
        flag_color: 'red',
      },
    });
  });

  it('passes payee_name when provided', async () => {
    mockClient.createTransaction.mockResolvedValue(createdTxnResponse());

    await handleCreateTransaction(
      { account_id: ACCOUNT_ID, date: '2024-02-01', amount: 50, payee_name: 'New Store' },
      mockClient as never
    );

    const callArg = mockClient.createTransaction.mock.calls[0]![1] as {
      transaction: { payee_name?: string; amount: number };
    };
    expect(callArg.transaction.payee_name).toBe('New Store');
    expect(callArg.transaction.amount).toBe(50000);
  });

  it('throws when no transaction is returned', async () => {
    mockClient.createTransaction.mockResolvedValue({ data: { transaction: null } });

    await expect(
      handleCreateTransaction(
        { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -10 },
        mockClient as never
      )
    ).rejects.toThrow('no transaction returned');
  });

  it('respects budget_id parameter', async () => {
    mockClient.createTransaction.mockResolvedValue(createdTxnResponse());

    await handleCreateTransaction(
      { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -10, budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });

  describe('import_id', () => {
    it('passes import_id to the API', async () => {
      mockClient.createTransaction.mockResolvedValue(createdTxnResponse());

      await handleCreateTransaction(
        { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1, import_id: 'YNAB:-1000:2024-02-01:1' },
        mockClient as never
      );

      const sent = mockClient.createTransaction.mock.calls[0]![1] as {
        transaction?: unknown;
        transactions: Array<Record<string, unknown>>;
      };
      // import_id uses the skip-duplicates (bulk) request form
      expect(sent.transaction).toBeUndefined();
      expect(sent.transactions).toHaveLength(1);
      expect(sent.transactions[0]!['import_id']).toBe('YNAB:-1000:2024-02-01:1');
    });

    it('reads the created transaction from the bulk-shaped response', async () => {
      mockClient.createTransaction.mockResolvedValue({
        data: { transactions: [createdTxnResponse().data.transaction], duplicate_import_ids: [] },
      });

      const parsed = JSON.parse(
        await handleCreateTransaction(
          { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -42.5, import_id: 'abc' },
          mockClient as never
        )
      );

      expect(parsed.success).toBe(true);
      expect(parsed.transaction.id).toBe('new-txn-001');
    });

    it('sends a plain transaction body when no import_id is given', async () => {
      mockClient.createTransaction.mockResolvedValue(createdTxnResponse());
      await handleCreateTransaction({ account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1 }, mockClient as never);
      const sent = mockClient.createTransaction.mock.calls[0]![1] as Record<string, unknown>;
      expect('transactions' in sent).toBe(false);
    });

    it('rejects an import_id over 36 characters and accepts exactly 36', async () => {
      mockClient.createTransaction.mockResolvedValue(createdTxnResponse());
      const args = { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1 };
      await expect(
        handleCreateTransaction({ ...args, import_id: 'x'.repeat(37) }, mockClient as never)
      ).rejects.toThrow();
      await expect(
        handleCreateTransaction({ ...args, import_id: 'x'.repeat(36) }, mockClient as never)
      ).resolves.toBeTypeOf('string');
    });

    it('reports a duplicate import_id as a result, not an error', async () => {
      mockClient.createTransaction.mockResolvedValue({
        data: { transactions: [], duplicate_import_ids: ['dup-1'] },
      });

      const parsed = JSON.parse(
        await handleCreateTransaction(
          { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1, import_id: 'dup-1' },
          mockClient as never
        )
      );

      expect(parsed.success).toBe(false);
      expect(parsed.duplicate_import_ids).toEqual(['dup-1']);
    });

    it('still throws when no transaction is returned and it is not a duplicate', async () => {
      mockClient.createTransaction.mockResolvedValue({ data: { transaction: undefined } });
      await expect(
        handleCreateTransaction({ account_id: ACCOUNT_ID, date: '2024-02-01', amount: -1 }, mockClient as never)
      ).rejects.toThrow(/no transaction returned/);
    });
  });
});
