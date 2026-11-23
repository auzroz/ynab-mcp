/**
 * A refused write makes no settings request (#49).
 *
 * Write tools format their response with the budget's currency format, which
 * can cost a settings request on a cold cache. A write refused in read-only
 * mode must not spend it: with the real client and fetch stubbed, nothing at
 * all goes over the wire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { ReadOnlyModeError } from '../../../src/utils/errors.js';
import { handleCreateTransaction } from '../../../src/tools/transactions/create-transaction.js';
import { handleCreateTransactions } from '../../../src/tools/transactions/create-transactions.js';
import { handleUpdateTransaction } from '../../../src/tools/transactions/update-transaction.js';
import { handleDeleteTransaction } from '../../../src/tools/transactions/delete-transaction.js';
import { handleCreateScheduledTransaction } from '../../../src/tools/scheduled-transactions/create-scheduled.js';
import { handleUpdateScheduledTransaction } from '../../../src/tools/scheduled-transactions/update-scheduled.js';
import { handleDeleteScheduledTransaction } from '../../../src/tools/scheduled-transactions/delete-scheduled.js';
import { handleCreateAccount } from '../../../src/tools/accounts/create-account.js';
import { handleCreateCategory } from '../../../src/tools/categories/create-category.js';
import { handleUpdateCategory } from '../../../src/tools/categories/update-category.js';
import { handleUpdateCategoryDetails } from '../../../src/tools/categories/update-category-details.js';
import { handleMoveMoney } from '../../../src/tools/categories/move-money.js';

const fetchMock = vi.fn<typeof fetch>();

const BUDGET = '99999999-9999-9999-9999-999999999999';
const ID = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const SOON = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

function readOnlyClient(): YnabClient {
  return new YnabClient('token', BUDGET, new RateLimiter(180), new Cache(300000), true, new AuditLog());
}

const cases: Array<[string, (client: YnabClient) => Promise<string>]> = [
  ['ynab_create_transaction', (c) => handleCreateTransaction({ budget_id: BUDGET, account_id: ID, date: '2024-02-01', amount: -10 }, c)],
  ['ynab_create_transactions', (c) => handleCreateTransactions({ budget_id: BUDGET, transactions: [{ account_id: ID, date: '2024-02-01', amount: -10 }] }, c)],
  ['ynab_update_transaction', (c) => handleUpdateTransaction({ budget_id: BUDGET, transaction_id: ID, amount: -10 }, c)],
  ['ynab_delete_transaction', (c) => handleDeleteTransaction({ budget_id: BUDGET, transaction_id: ID }, c)],
  ['ynab_create_scheduled_transaction', (c) => handleCreateScheduledTransaction({ budget_id: BUDGET, account_id: ID, date: SOON, amount: -10, frequency: 'monthly', payee_name: 'P' }, c)],
  ['ynab_update_scheduled_transaction', (c) => handleUpdateScheduledTransaction({ budget_id: BUDGET, scheduled_transaction_id: ID, amount: -10 }, c)],
  ['ynab_delete_scheduled_transaction', (c) => handleDeleteScheduledTransaction({ budget_id: BUDGET, scheduled_transaction_id: ID }, c)],
  ['ynab_create_account', (c) => handleCreateAccount({ budget_id: BUDGET, name: 'A', type: 'checking', balance: 0 }, c)],
  ['ynab_create_category', (c) => handleCreateCategory({ budget_id: BUDGET, name: 'C', category_group_id: ID }, c)],
  ['ynab_update_category', (c) => handleUpdateCategory({ budget_id: BUDGET, category_id: ID, month: '2024-02-01', budgeted: 10 }, c)],
  ['ynab_update_category_details', (c) => handleUpdateCategoryDetails({ budget_id: BUDGET, category_id: ID, name: 'N' }, c)],
  ['ynab_move_money', (c) => handleMoveMoney({ budget_id: BUDGET, from_category_id: ID, to_category_id: ID2, amount: 5, month: 'current' }, c)],
];

describe('a write refused in read-only mode makes no request', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(cases)('%s', async (_name, run) => {
    await expect(run(readOnlyClient())).rejects.toBeInstanceOf(ReadOnlyModeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
