/**
 * Transaction read tools return the ids needed to chain into other tools.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListTransactions } from '../../../../src/tools/transactions/list-transactions.js';
import { handleListAccountTransactions } from '../../../../src/tools/transactions/list-account-transactions.js';
import { handleListCategoryTransactions } from '../../../../src/tools/transactions/list-category-transactions.js';
import { handleListPayeeTransactions } from '../../../../src/tools/transactions/list-payee-transactions.js';
import { handleGetTransaction } from '../../../../src/tools/transactions/get-transaction.js';
import { handleListScheduledTransactions } from '../../../../src/tools/scheduled-transactions/list-scheduled.js';
import { handleGetScheduledTransaction } from '../../../../src/tools/scheduled-transactions/get-scheduled.js';
import {
  createMockClient,
  createScheduledTransactionResponse,
  createScheduledTransactionsResponse,
  createTransactionResponse,
  createTransactionsResponse,
  mockGroceryTransactions,
  mockScheduledTransactions,
  mockSplitTransaction,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';
import type { ScheduledTransactionDetail } from 'ynab';

const UUID = '11111111-1111-1111-1111-111111111111';

const CHAIN_KEYS = [
  'account_id',
  'payee_id',
  'category_id',
  'transfer_account_id',
  'transfer_transaction_id',
  'matched_transaction_id',
  'import_id',
  'debt_transaction_type',
] as const;

// A fully populated transaction (a matched, imported credit-card payment transfer).
const full = {
  ...mockGroceryTransactions[0]!,
  id: 'txn-full',
  payee_id: 'payee-1',
  category_id: 'cat-1',
  transfer_account_id: 'acct-transfer',
  transfer_transaction_id: 'txn-transfer',
  matched_transaction_id: 'txn-matched',
  import_id: 'YNAB:-85000:2024-01-05:1',
  debt_transaction_type: 'payment',
};

describe('transaction list/get outputs carry chaining ids', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  const expectFull = (txn: Record<string, unknown>) => {
    expect(txn.account_id).toBe(full.account_id);
    expect(txn.payee_id).toBe('payee-1');
    expect(txn.category_id).toBe('cat-1');
    expect(txn.transfer_account_id).toBe('acct-transfer');
    expect(txn.transfer_transaction_id).toBe('txn-transfer');
    expect(txn.matched_transaction_id).toBe('txn-matched');
    expect(txn.import_id).toBe('YNAB:-85000:2024-01-05:1');
    expect(txn.debt_transaction_type).toBe('payment');
  };

  it('ynab_list_transactions', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([full]));
    const parsed = JSON.parse(await handleListTransactions({}, mockClient as never));
    expectFull(parsed.transactions[0]);
    // existing fields are kept
    expect(parsed.transactions[0].payee_name).toBe('Kroger');
    expect(parsed.transactions[0].amount).toBe('-$85.00');
  });

  it('ynab_list_transactions includes split ids', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([mockSplitTransaction]));
    const parsed = JSON.parse(await handleListTransactions({}, mockClient as never));
    const subs = parsed.transactions[0].subtransactions;
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({
      id: 'sub-001',
      transaction_id: 'txn-split-001',
      category_id: 'cat-entertainment-ccc',
      amount: '-$100.00',
      category_name: 'Entertainment',
    });
    expect(subs[0]).toHaveProperty('payee_id', null);
    expect(subs[0]).toHaveProperty('transfer_account_id', null);
    expect(subs[0]).toHaveProperty('transfer_transaction_id', null);
  });

  it('ynab_list_transactions emits null (not missing keys) for absent ids', async () => {
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse([mockGroceryTransactions[0]!, { ...full, id: 'x', import_id: undefined } as never])
    );
    const parsed = JSON.parse(await handleListTransactions({}, mockClient as never));
    for (const txn of parsed.transactions) {
      for (const key of CHAIN_KEYS) expect(txn).toHaveProperty(key);
    }
    const noImport = parsed.transactions.find((t: { id: string }) => t.id === 'x');
    expect(noImport.import_id).toBeNull();
  });

  it('ynab_list_account_transactions, with splits', async () => {
    mockClient.getAccountTransactions.mockResolvedValue(
      createTransactionsResponse([full, mockSplitTransaction])
    );
    const parsed = JSON.parse(
      await handleListAccountTransactions({ account_id: UUID }, mockClient as never)
    );
    const byId = Object.fromEntries(parsed.transactions.map((t: { id: string }) => [t.id, t]));
    expectFull(byId['txn-full']);
    expect(byId['txn-full'].subtransactions).toBeUndefined();
    expect(byId['txn-split-001'].subtransactions.map((s: { id: string }) => s.id)).toEqual([
      'sub-001',
      'sub-002',
    ]);
    // existing fields are kept
    expect(byId['txn-full'].cleared).toBe('cleared');
    expect(byId['txn-full'].approved).toBe(true);
  });

  it('ynab_list_category_transactions, including hybrid split rows', async () => {
    const hybridSub = { ...full, id: 'sub-001', type: 'subtransaction', parent_transaction_id: 'txn-split-001' };
    mockClient.getCategoryTransactions.mockResolvedValue(
      createTransactionsResponse([full, hybridSub as never])
    );
    const parsed = JSON.parse(
      await handleListCategoryTransactions({ category_id: UUID }, mockClient as never)
    );
    const byId = Object.fromEntries(parsed.transactions.map((t: { id: string }) => [t.id, t]));
    expectFull(byId['txn-full']);
    expect(byId['sub-001'].type).toBe('subtransaction');
    expect(byId['sub-001'].parent_transaction_id).toBe('txn-split-001');
    expect(byId['txn-full'].parent_transaction_id).toBeNull();
    expect(byId['txn-full'].account_name).toBe('Primary Checking');
  });

  it('ynab_list_payee_transactions', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(createTransactionsResponse([full]));
    const parsed = JSON.parse(
      await handleListPayeeTransactions({ payee_id: UUID }, mockClient as never)
    );
    expectFull(parsed.transactions[0]);
    expect(parsed.transactions[0].category_name).toBe('Groceries');
  });

  it('ynab_get_transaction keeps all ids, including split ids', async () => {
    mockClient.getTransactionById.mockResolvedValue(createTransactionResponse(full));
    const parsed = JSON.parse(
      await handleGetTransaction({ transaction_id: UUID }, mockClient as never)
    );
    expectFull(parsed.transaction);

    mockClient.getTransactionById.mockResolvedValue(createTransactionResponse(mockSplitTransaction));
    const split = JSON.parse(
      await handleGetTransaction({ transaction_id: UUID }, mockClient as never)
    );
    expect(split.transaction.subtransactions[0]).toMatchObject({
      id: 'sub-001',
      transaction_id: 'txn-split-001',
      category_id: 'cat-entertainment-ccc',
    });
  });
});

describe('scheduled transaction outputs carry account/payee/category/transfer ids', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  const withSplit: ScheduledTransactionDetail = {
    ...mockScheduledTransactions[0]!,
    id: 'sched-split',
    transfer_account_id: 'acct-transfer',
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
        transfer_account_id: 'acct-sub-transfer',
        deleted: false,
      },
    ],
  };

  it('ynab_list_scheduled_transactions', async () => {
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse([mockScheduledTransactions[0]!, withSplit])
    );
    const parsed = JSON.parse(await handleListScheduledTransactions({}, mockClient as never));
    const byId = Object.fromEntries(
      parsed.scheduled_transactions.map((t: { id: string }) => [t.id, t])
    );
    const rent = byId['sched-rent-001'];
    expect(rent.account_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(rent.payee_id).toBe('payee-landlord');
    expect(rent.category_id).toBe('cat-rent-111');
    expect(rent.transfer_account_id).toBeNull();
    expect(rent.payee_name).toBe('ABC Property Management');

    const split = byId['sched-split'];
    expect(split.transfer_account_id).toBe('acct-transfer');
    expect(split.subtransactions[0]).toMatchObject({
      id: 'sub-1',
      scheduled_transaction_id: 'sched-split',
      payee_id: 'payee-x',
      category_id: 'cat-x',
      transfer_account_id: 'acct-sub-transfer',
    });
  });

  it('ynab_get_scheduled_transaction', async () => {
    mockClient.getScheduledTransactionById.mockResolvedValue(
      createScheduledTransactionResponse(withSplit)
    );
    const parsed = JSON.parse(
      await handleGetScheduledTransaction({ scheduled_transaction_id: UUID }, mockClient as never)
    );
    const txn = parsed.scheduled_transaction;
    expect(txn.account_id).toBe(withSplit.account_id);
    expect(txn.payee_id).toBe(withSplit.payee_id);
    expect(txn.category_id).toBe(withSplit.category_id);
    expect(txn.transfer_account_id).toBe('acct-transfer');
    expect(txn.subtransactions[0]).toMatchObject({
      id: 'sub-1',
      scheduled_transaction_id: 'sched-split',
      transfer_account_id: 'acct-sub-transfer',
    });
  });
});
