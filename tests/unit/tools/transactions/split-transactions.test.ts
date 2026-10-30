/**
 * Split transactions (subtransactions) on ynab_create_transaction and ynab_create_transactions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { handleCreateTransaction, createTransactionTool } from '../../../../src/tools/transactions/create-transaction.js';
import { handleCreateTransactions, createTransactionsTool } from '../../../../src/tools/transactions/create-transactions.js';
import { updateTransactionTool } from '../../../../src/tools/transactions/update-transaction.js';
import { createScheduledTransactionTool } from '../../../../src/tools/scheduled-transactions/create-scheduled.js';
import { updateScheduledTransactionTool } from '../../../../src/tools/scheduled-transactions/update-scheduled.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const PAYEE_ID = '22222222-2222-2222-2222-222222222222';
const CAT_A = '33333333-3333-3333-3333-333333333333';
const CAT_B = '44444444-4444-4444-4444-444444444444';

const base = { account_id: ACCOUNT_ID, date: '2024-02-01', amount: -100 };
const twoSplits = [
  { amount: -60, category_id: CAT_A, memo: 'groceries' },
  { amount: -40, category_id: CAT_B, payee_name: 'Hardware Store' },
];

function createdWithSplits() {
  return {
    data: {
      transaction: {
        id: 'new-txn-001',
        date: '2024-02-01',
        amount: -100000,
        payee_name: 'Big Box',
        category_name: 'Split (Multiple Categories)...',
        account_name: 'Checking',
        memo: null,
        cleared: 'uncleared',
        approved: true,
        subtransactions: [
          {
            id: 'sub-1',
            transaction_id: 'new-txn-001',
            amount: -60000,
            memo: 'groceries\u0007',
            payee_id: null,
            payee_name: null,
            category_id: CAT_A,
            category_name: 'Groceries',
            deleted: false,
          },
          {
            id: 'sub-2',
            transaction_id: 'new-txn-001',
            amount: -40000,
            memo: null,
            payee_id: PAYEE_ID,
            payee_name: 'Hardware Store',
            category_id: CAT_B,
            category_name: 'Household',
            deleted: false,
          },
          { id: 'sub-3', transaction_id: 'new-txn-001', amount: 0, deleted: true },
        ],
      },
    },
  };
}

describe('ynab_create_transaction splits', () => {
  let mockClient: MockClient;
  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('sends subtransactions in milliunits and returns sanitized splits', async () => {
    mockClient.createTransaction.mockResolvedValue(createdWithSplits());

    const parsed = JSON.parse(
      await handleCreateTransaction({ ...base, subtransactions: twoSplits }, mockClient as never)
    );

    expect(mockClient.createTransaction).toHaveBeenCalledWith('test-budget-id', {
      transaction: {
        ...base,
        amount: -100000,
        subtransactions: [
          { amount: -60000, category_id: CAT_A, memo: 'groceries' },
          { amount: -40000, category_id: CAT_B, payee_name: 'Hardware Store' },
        ],
      },
    });
    // Deleted splits are dropped; control chars are stripped; money is formatted and raw.
    expect(parsed.transaction.subtransactions).toEqual([
      {
        id: 'sub-1',
        amount: '-$60.00',
        amount_milliunits: -60000,
        payee_id: null,
        payee_name: 'Unknown',
        category_id: CAT_A,
        category_name: 'Groceries',
        memo: 'groceries',
      },
      {
        id: 'sub-2',
        amount: '-$40.00',
        amount_milliunits: -40000,
        payee_id: PAYEE_ID,
        payee_name: 'Hardware Store',
        category_id: CAT_B,
        category_name: 'Household',
        memo: null,
      },
    ]);
  });

  it('omits subtransactions from the output when the transaction is not split', async () => {
    mockClient.createTransaction.mockResolvedValue({
      data: { transaction: { ...createdWithSplits().data.transaction, subtransactions: [] } },
    });
    const parsed = JSON.parse(await handleCreateTransaction(base, mockClient as never));
    expect('subtransactions' in parsed.transaction).toBe(false);
  });

  it('does not send subtransactions when none are given', async () => {
    mockClient.createTransaction.mockResolvedValue(createdWithSplits());
    await handleCreateTransaction(base, mockClient as never);
    const sent = mockClient.createTransaction.mock.calls[0]![1] as { transaction: Record<string, unknown> };
    expect('subtransactions' in sent.transaction).toBe(false);
  });

  it('sums splits with decimal math (no float drift)', async () => {
    mockClient.createTransaction.mockResolvedValue(createdWithSplits());
    // 0.1 + 0.2 !== 0.3 in JS floats; must be accepted as exactly 0.30.
    await expect(
      handleCreateTransaction(
        {
          ...base,
          amount: 0.3,
          subtransactions: [
            { amount: 0.1, category_id: CAT_A },
            { amount: 0.2, category_id: CAT_B },
          ],
        },
        mockClient as never
      )
    ).resolves.toBeTypeOf('string');
  });

  it('rejects splits that do not sum to the parent amount', async () => {
    const err = await handleCreateTransaction(
      { ...base, subtransactions: [{ amount: -60 }, { amount: -39.99 }] },
      mockClient as never
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).message).toContain('sum exactly');
    expect(mockClient.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects fewer than two splits', async () => {
    await expect(
      handleCreateTransaction({ ...base, subtransactions: [{ amount: -100 }] }, mockClient as never)
    ).rejects.toBeInstanceOf(ZodError);
    await expect(handleCreateTransaction({ ...base, subtransactions: [] }, mockClient as never)).rejects.toBeInstanceOf(
      ZodError
    );
  });

  it('rejects a parent category_id alongside splits', async () => {
    const err = await handleCreateTransaction(
      { ...base, category_id: CAT_A, subtransactions: twoSplits },
      mockClient as never
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).message).toContain('category_id');
  });

  it('rejects a split with both payee_id and payee_name, an overlong memo, or a bad category id', async () => {
    for (const bad of [
      { amount: -50, payee_id: PAYEE_ID, payee_name: 'X' },
      { amount: -50, memo: 'x'.repeat(501) },
      { amount: -50, category_id: 'not-a-uuid' },
    ]) {
      await expect(
        handleCreateTransaction({ ...base, subtransactions: [bad, { amount: -50 }] }, mockClient as never)
      ).rejects.toBeInstanceOf(ZodError);
    }
  });
});

describe('ynab_create_transactions splits', () => {
  let mockClient: MockClient;
  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('supports splits on individual items and returns them', async () => {
    mockClient.createTransaction.mockResolvedValue({
      data: {
        transactions: [createdWithSplits().data.transaction, { id: 'plain', date: '2024-02-02', amount: -5000 }],
        duplicate_import_ids: [],
      },
    });

    const parsed = JSON.parse(
      await handleCreateTransactions(
        {
          transactions: [
            { ...base, subtransactions: twoSplits },
            { account_id: ACCOUNT_ID, date: '2024-02-02', amount: -5 },
          ],
        },
        mockClient as never
      )
    );

    const sent = mockClient.createTransaction.mock.calls[0]![1] as { transactions: Array<Record<string, unknown>> };
    expect(sent.transactions[0]!.subtransactions).toEqual([
      { amount: -60000, category_id: CAT_A, memo: 'groceries' },
      { amount: -40000, category_id: CAT_B, payee_name: 'Hardware Store' },
    ]);
    expect('subtransactions' in sent.transactions[1]!).toBe(false);
    expect(parsed.transactions[0].subtransactions).toHaveLength(2);
    expect(parsed.transactions[0].subtransactions[0].amount).toBe('-$60.00');
    expect('subtransactions' in parsed.transactions[1]).toBe(false);
  });

  it('applies the same validation per item', async () => {
    await expect(
      handleCreateTransactions(
        { transactions: [{ ...base, subtransactions: [{ amount: -1 }, { amount: -2 }] }] },
        mockClient as never
      )
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      handleCreateTransactions(
        { transactions: [{ ...base, category_id: CAT_A, subtransactions: twoSplits }] },
        mockClient as never
      )
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe('split documentation and JSON schema', () => {
  it('both create tools declare subtransactions with capped splits', () => {
    const single = (createTransactionTool.inputSchema as { properties: Record<string, any> }).properties;
    const bulk = (createTransactionsTool.inputSchema as { properties: Record<string, any> }).properties;
    for (const subs of [single.subtransactions, bulk.transactions.items.properties.subtransactions]) {
      expect(subs.minItems).toBe(2);
      expect(subs.items.properties.memo.maxLength).toBe(500);
      expect(subs.items.properties.payee_name.maxLength).toBe(200);
      expect(subs.items.required).toEqual(['amount']);
    }
  });

  it('update and scheduled tool descriptions state the YNAB split limitations', () => {
    expect(updateTransactionTool.description).toMatch(/cannot (edit|change) the splits/i);
    expect(createScheduledTransactionTool.description).toMatch(/cannot be split|split/i);
    expect(updateScheduledTransactionTool.description).toMatch(/split/i);
  });
});
