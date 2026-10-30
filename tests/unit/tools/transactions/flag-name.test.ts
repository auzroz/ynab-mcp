/**
 * flag_name: the user's label for a flag colour, returned next to flag_color.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleListTransactions } from '../../../../src/tools/transactions/list-transactions.js';
import { handleListAccountTransactions } from '../../../../src/tools/transactions/list-account-transactions.js';
import { handleListCategoryTransactions } from '../../../../src/tools/transactions/list-category-transactions.js';
import { handleListPayeeTransactions } from '../../../../src/tools/transactions/list-payee-transactions.js';
import { handleGetTransaction } from '../../../../src/tools/transactions/get-transaction.js';
import { handleListScheduledTransactions } from '../../../../src/tools/scheduled-transactions/list-scheduled.js';
import { handleGetScheduledTransaction } from '../../../../src/tools/scheduled-transactions/get-scheduled.js';
import { YnabClient } from '../../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../../src/services/rate-limiter.js';
import { Cache } from '../../../../src/services/cache.js';
import { AuditLog } from '../../../../src/services/audit-log.js';
import {
  createMockClient,
  createScheduledTransactionResponse,
  createScheduledTransactionsResponse,
  createTransactionResponse,
  createTransactionsResponse,
  mockGroceryTransactions,
  mockScheduledTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const UUID = '11111111-1111-1111-1111-111111111111';

const flagged = { ...mockGroceryTransactions[0]!, flag_color: 'red', flag_name: 'Needs receipt' };
const unflagged = { ...mockGroceryTransactions[1]!, flag_color: null, flag_name: null };

describe('flag_name in transaction read tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  const expectNames = (txns: { id: string; flag_color?: unknown; flag_name?: unknown }[]) => {
    const a = txns.find((t) => t.id === flagged.id)!;
    const b = txns.find((t) => t.id === unflagged.id)!;
    expect(a.flag_color).toBe('red');
    expect(a.flag_name).toBe('Needs receipt');
    expect(b.flag_name).toBeNull();
  };

  it('ynab_list_transactions', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([flagged, unflagged]));
    expectNames(JSON.parse(await handleListTransactions({}, mockClient as never)).transactions);
  });

  it('ynab_list_account_transactions', async () => {
    mockClient.getAccountTransactions.mockResolvedValue(createTransactionsResponse([flagged, unflagged]));
    expectNames(
      JSON.parse(await handleListAccountTransactions({ account_id: UUID }, mockClient as never)).transactions
    );
  });

  it('ynab_list_category_transactions', async () => {
    mockClient.getCategoryTransactions.mockResolvedValue(createTransactionsResponse([flagged, unflagged]));
    expectNames(
      JSON.parse(await handleListCategoryTransactions({ category_id: UUID }, mockClient as never)).transactions
    );
  });

  it('ynab_list_payee_transactions', async () => {
    mockClient.getPayeeTransactions.mockResolvedValue(createTransactionsResponse([flagged, unflagged]));
    expectNames(
      JSON.parse(await handleListPayeeTransactions({ payee_id: UUID }, mockClient as never)).transactions
    );
  });

  it('ynab_get_transaction', async () => {
    mockClient.getTransactionById.mockResolvedValue(createTransactionResponse(flagged));
    const parsed = JSON.parse(await handleGetTransaction({ transaction_id: UUID }, mockClient as never));
    expect(parsed.transaction.flag_color).toBe('red');
    expect(parsed.transaction.flag_name).toBe('Needs receipt');
  });

  it('sanitizes the label: control characters stripped, length capped, empty becomes null', async () => {
    const dirty = { ...flagged, id: 'dirty', flag_name: 'Re\u0000view​ me\n' };
    const long = { ...flagged, id: 'long', flag_name: 'x'.repeat(500) };
    const blank = { ...flagged, id: 'blank', flag_name: '   ' };
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([dirty, long, blank]));
    const txns = JSON.parse(await handleListTransactions({}, mockClient as never)).transactions;
    const by = (id: string) => txns.find((t: { id: string }) => t.id === id).flag_name;
    expect(by('dirty')).toBe('Review me');
    expect(by('long')).toHaveLength(100);
    expect(by('blank')).toBeNull();
  });

  it('ynab_list_scheduled_transactions and ynab_get_scheduled_transaction', async () => {
    const sched = { ...mockScheduledTransactions[0]!, flag_color: 'blue' as const, flag_name: 'Autopay' };
    mockClient.getScheduledTransactions.mockResolvedValue(
      createScheduledTransactionsResponse([sched, mockScheduledTransactions[1]!])
    );
    const list = JSON.parse(await handleListScheduledTransactions({}, mockClient as never));
    const a = list.scheduled_transactions.find((t: { id: string }) => t.id === sched.id);
    const b = list.scheduled_transactions.find((t: { id: string }) => t.id === mockScheduledTransactions[1]!.id);
    expect(a.flag_color).toBe('blue');
    expect(a.flag_name).toBe('Autopay');
    expect(b.flag_name).toBeNull();

    mockClient.getScheduledTransactionById.mockResolvedValue(createScheduledTransactionResponse(sched));
    const got = JSON.parse(
      await handleGetScheduledTransaction({ scheduled_transaction_id: UUID }, mockClient as never)
    );
    expect(got.scheduled_transaction.flag_name).toBe('Autopay');
  });
});

describe('ynab SDK response parsing keeps flag_name and chaining ids', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const client = () =>
    new YnabClient('token', 'budget-1', new RateLimiter(180), new Cache(300000), false, new AuditLog());

  const wireTxn = {
    id: 'txn-1',
    date: '2024-01-05',
    amount: -85000,
    cleared: 'cleared',
    approved: true,
    account_id: 'acct-1',
    account_name: 'Checking',
    flag_color: 'red',
    flag_name: 'Needs receipt',
    payee_id: 'payee-1',
    category_id: 'cat-1',
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: 'txn-m',
    import_id: 'YNAB:-85000:2024-01-05:1',
    debt_transaction_type: 'payment',
    deleted: false,
    subtransactions: [],
  };

  it('getTransactionById', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: wireTxn } }));
    const parsed = JSON.parse(
      await handleGetTransaction({ transaction_id: UUID }, client() as never)
    );
    expect(parsed.transaction.flag_name).toBe('Needs receipt');
    expect(parsed.transaction.matched_transaction_id).toBe('txn-m');
    expect(parsed.transaction.import_id).toBe('YNAB:-85000:2024-01-05:1');
    expect(parsed.transaction.debt_transaction_type).toBe('payment');
  });

  it('getTransactionsByAccount with the type filter sends type on the wire', async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: { transactions: [wireTxn], server_knowledge: 5 } })
    );
    const parsed = JSON.parse(
      await handleListAccountTransactions(
        { account_id: UUID, type: 'unapproved' },
        client() as never
      )
    );
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toMatch(/\/accounts\/.+\/transactions$/);
    expect(url.searchParams.get('type')).toBe('unapproved');
    expect(parsed.transactions[0].flag_name).toBe('Needs receipt');
    expect(parsed.transactions[0].debt_transaction_type).toBe('payment');
  });

  it('getTransactionsByCategory and ByPayee send the type filter and keep hybrid fields', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        data: {
          transactions: [{ ...wireTxn, type: 'subtransaction', parent_transaction_id: 'txn-p' }],
          server_knowledge: 5,
        },
      })
    );
    const cat = JSON.parse(
      await handleListCategoryTransactions(
        { category_id: UUID, type: 'uncategorized' },
        client() as never
      )
    );
    const payee = JSON.parse(
      await handleListPayeeTransactions(
        { payee_id: UUID, type: 'unapproved' },
        client() as never
      )
    );
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('type')).toBe('uncategorized');
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('type')).toBe('unapproved');
    for (const out of [cat, payee]) {
      expect(out.transactions[0].flag_name).toBe('Needs receipt');
      expect(out.transactions[0].type).toBe('subtransaction');
      expect(out.transactions[0].parent_transaction_id).toBe('txn-p');
    }
  });

  it('getScheduledTransactionById', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        data: {
          scheduled_transaction: {
            id: 'sched-1',
            date_first: '2024-01-01',
            date_next: '2024-02-01',
            frequency: 'monthly',
            amount: -1000,
            account_id: 'acct-1',
            account_name: 'Checking',
            flag_color: 'blue',
            flag_name: 'Autopay',
            payee_id: 'p',
            category_id: 'c',
            transfer_account_id: 't',
            deleted: false,
            subtransactions: [],
          },
        },
      })
    );
    const parsed = JSON.parse(
      await handleGetScheduledTransaction({ scheduled_transaction_id: UUID }, client() as never)
    );
    expect(parsed.scheduled_transaction.flag_name).toBe('Autopay');
    expect(parsed.scheduled_transaction.transfer_account_id).toBe('t');
  });
});
