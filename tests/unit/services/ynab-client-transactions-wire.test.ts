/**
 * Transaction write payloads as the real ynab SDK serializes them, with fetch stubbed.
 *
 * The SDK's generated ToJSON functions can drop or reshape fields, so every field
 * the transaction tools rely on is checked here against the request body that
 * would actually be sent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { handleCreateTransaction } from '../../../src/tools/transactions/create-transaction.js';
import { handleCreateTransactions } from '../../../src/tools/transactions/create-transactions.js';
import { handleUpdateTransaction } from '../../../src/tools/transactions/update-transaction.js';
import { handleUpdateTransactions } from '../../../src/tools/transactions/update-transactions.js';

const fetchMock = vi.fn<typeof fetch>();

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const CAT_A = '33333333-3333-3333-3333-333333333333';
const CAT_B = '44444444-4444-4444-4444-444444444444';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let auditLog: AuditLog;

function makeClient(): YnabClient {
  auditLog = new AuditLog();
  return new YnabClient('token', 'budget-1', new RateLimiter(180), new Cache(300000), false, auditLog);
}

/** URL, method and parsed JSON body of the n-th fetch call. */
function request(n = 0): { url: string; method: string | undefined; body: any } {
  const [url, init] = fetchMock.mock.calls[n]!;
  return { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) };
}

const savedTxn = {
  id: 't1',
  date: '2024-02-01',
  amount: -100000,
  cleared: 'uncleared',
  approved: true,
  account_id: ACCOUNT,
  account_name: 'Checking',
  deleted: false,
  subtransactions: [],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('split transactions on the wire', () => {
  it('ynab_create_transaction sends subtransactions in milliunits', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: savedTxn, server_knowledge: 1 } }));

    await handleCreateTransaction(
      {
        account_id: ACCOUNT,
        date: '2024-02-01',
        amount: -100,
        subtransactions: [
          { amount: -60, category_id: CAT_A, memo: 'a' },
          { amount: -40, category_id: CAT_B, payee_name: 'Hardware' },
        ],
      },
      makeClient()
    );

    const { url, method, body } = request();
    expect(url).toBe('https://api.ynab.com/v1/plans/budget-1/transactions');
    expect(method).toBe('POST');
    expect(body.transaction.amount).toBe(-100000);
    expect(body.transaction).not.toHaveProperty('category_id');
    expect(body.transaction.subtransactions).toEqual([
      { amount: -60000, category_id: CAT_A, memo: 'a' },
      { amount: -40000, category_id: CAT_B, payee_name: 'Hardware' },
    ]);
  });

  it('ynab_create_transactions sends subtransactions on the split item only', async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: { transactions: [savedTxn], transaction_ids: ['t1'], server_knowledge: 1 } })
    );

    await handleCreateTransactions(
      {
        transactions: [
          {
            account_id: ACCOUNT,
            date: '2024-02-01',
            amount: -100,
            subtransactions: [
              { amount: -60, category_id: CAT_A },
              { amount: -40, category_id: CAT_B },
            ],
          },
          { account_id: ACCOUNT, date: '2024-02-01', amount: -5 },
        ],
      },
      makeClient()
    );

    const { body } = request();
    expect(body.transactions[0].subtransactions).toEqual([
      { amount: -60000, category_id: CAT_A },
      { amount: -40000, category_id: CAT_B },
    ]);
    expect(body.transactions[1]).not.toHaveProperty('subtransactions');
  });

  it('audit log records only the split count, never split memos or payees', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: savedTxn, server_knowledge: 1 } }));

    await handleCreateTransaction(
      {
        account_id: ACCOUNT,
        date: '2024-02-01',
        amount: -100,
        subtransactions: [
          { amount: -60, memo: 'secret memo' },
          { amount: -40, payee_name: 'Secret Payee' },
        ],
      },
      makeClient()
    );

    const entry = auditLog.getAll().at(-1)!;
    expect(entry.details['split_count']).toBe(2);
    expect(JSON.stringify(entry)).not.toMatch(/secret/i);
  });
});

describe('clearing fields with null on the wire', () => {
  it('ynab_update_transaction sends category_id, payee_id and memo as JSON null', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: savedTxn, server_knowledge: 1 } }));

    await handleUpdateTransaction({ transaction_id: ACCOUNT, category_id: null, payee_id: null, memo: null }, makeClient());

    const { url, method, body } = request();
    expect(url).toBe(`https://api.ynab.com/v1/plans/budget-1/transactions/${ACCOUNT}`);
    expect(method).toBe('PUT');
    expect(body).toEqual({ transaction: { category_id: null, payee_id: null, memo: null } });
    // Explicit nulls survive serialization (key present), unlike omitted fields.
    expect(Object.keys(body.transaction).sort()).toEqual(['category_id', 'memo', 'payee_id']);
  });

  it('ynab_update_transaction omits untouched fields entirely', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: savedTxn, server_knowledge: 1 } }));

    await handleUpdateTransaction({ transaction_id: ACCOUNT, memo: 'hi' }, makeClient());

    expect(request().body).toEqual({ transaction: { memo: 'hi' } });
  });

  it('ynab_update_transactions sends nulls in the bulk PATCH', async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: { transaction_ids: ['t1', 't2'], transactions: [], server_knowledge: 1 } })
    );

    await handleUpdateTransactions(
      {
        transactions: [
          { id: CAT_A, category_id: null, memo: null },
          { id: CAT_B, payee_id: null },
        ],
      },
      makeClient()
    );

    const { url, method, body } = request();
    expect(url).toBe('https://api.ynab.com/v1/plans/budget-1/transactions');
    expect(method).toBe('PATCH');
    expect(body.transactions).toEqual([
      { id: CAT_A, category_id: null, memo: null },
      { id: CAT_B, payee_id: null },
    ]);
  });

  it('audit log names the cleared fields without values', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: savedTxn, server_knowledge: 1 } }));
    await handleUpdateTransaction({ transaction_id: ACCOUNT, category_id: null, memo: null }, makeClient());
    expect(auditLog.getAll().at(-1)!.details['cleared_fields']).toEqual(['category_id', 'memo']);
  });
});

describe('import_id on the wire', () => {
  it('ynab_create_transaction sends import_id', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        data: { transaction_ids: ['t1'], transactions: [savedTxn], duplicate_import_ids: [], server_knowledge: 1 },
      })
    );

    const out = JSON.parse(
      await handleCreateTransaction(
        { account_id: ACCOUNT, date: '2024-02-01', amount: -1, import_id: 'YNAB:-1000:2024-02-01:1' },
        makeClient()
      )
    );

    const { body } = request();
    expect(body.transaction).toBeUndefined();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].import_id).toBe('YNAB:-1000:2024-02-01:1');
    expect(out.success).toBe(true);
    expect(out.transaction.id).toBe('t1');
    expect(auditLog.getAll().some((e) => e.resourceId === 't1')).toBe(true);
  });

  it('ynab_create_transaction reports a duplicate import_id (skip-duplicates response) as a result', async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: { transaction_ids: [], transactions: [], duplicate_import_ids: ['dup-1'], server_knowledge: 1 } })
    );

    const out = JSON.parse(
      await handleCreateTransaction(
        { account_id: ACCOUNT, date: '2024-02-01', amount: -1, import_id: 'dup-1' },
        makeClient()
      )
    );

    expect(out.success).toBe(false);
    expect(out.duplicate_import_ids).toEqual(['dup-1']);
  });

  it('ynab_create_transaction without import_id keeps the single-transaction body', async () => {
    fetchMock.mockImplementation(async () => json({ data: { transaction: savedTxn, server_knowledge: 1 } }));
    await handleCreateTransaction({ account_id: ACCOUNT, date: '2024-02-01', amount: -1 }, makeClient());
    expect(request().body.transaction.amount).toBe(-1000);
    expect(request().body.transactions).toBeUndefined();
  });

  it('ynab_update_transactions addresses rows by import_id without an id', async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: { transaction_ids: ['t1', 't2'], transactions: [], server_knowledge: 1 } })
    );

    await handleUpdateTransactions(
      {
        transactions: [
          { import_id: 'YNAB:-1000:2024-02-01:1', approved: true },
          { id: CAT_A, approved: true },
        ],
      },
      makeClient()
    );

    const { body } = request();
    expect(body.transactions[0]).toEqual({ import_id: 'YNAB:-1000:2024-02-01:1', approved: true });
    expect(body.transactions[0]).not.toHaveProperty('id');
    expect(body.transactions[1]).toEqual({ id: CAT_A, approved: true });
    expect(body.transactions[1]).not.toHaveProperty('import_id');
    expect(auditLog.getAll().at(-1)!.details['addressed_by_import_id_count']).toBe(1);
  });
});
