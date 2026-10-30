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
