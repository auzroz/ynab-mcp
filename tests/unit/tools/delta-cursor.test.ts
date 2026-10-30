/**
 * The since_server_knowledge cursor on the list tools:
 * - without it, the client is called as before and the output gains only
 *   server_knowledge;
 * - with it, the client gets lastKnowledgeOfServer and the output is marked
 *   delta: true, lists deleted entities by id and gives no totals;
 * - invalid cursors are rejected by the input schema;
 * - end to end (real YnabClient on a fake YNAB): the server_knowledge a full
 *   response returns works as the next call's cursor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleListAccounts } from '../../../src/tools/accounts/list-accounts.js';
import { handleListCategories } from '../../../src/tools/categories/list-categories.js';
import { handleListMonths } from '../../../src/tools/months/list-months.js';
import { handleListPayees } from '../../../src/tools/payees/list-payees.js';
import { handleListScheduledTransactions } from '../../../src/tools/scheduled-transactions/list-scheduled.js';
import { handleListTransactions } from '../../../src/tools/transactions/list-transactions.js';
import { handleListAccountTransactions } from '../../../src/tools/transactions/list-account-transactions.js';
import { handleListCategoryTransactions } from '../../../src/tools/transactions/list-category-transactions.js';
import { handleListPayeeTransactions } from '../../../src/tools/transactions/list-payee-transactions.js';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { DeltaCache } from '../../../src/services/delta-cache.js';
import { FakeYnab, FAKE_BUDGET } from '../helpers/fake-ynab.js';
import {
  createMockClient,
  createAccountsResponse,
  createCategoriesResponse,
  createMonthsResponse,
  createPayeesResponse,
  createScheduledTransactionsResponse,
  createTransactionsResponse,
  mockAllAccounts,
  mockCategoryGroups,
  mockGroceryTransactions,
  mockMonthSummaries,
  mockPayees,
  mockScheduledTransactions,
} from './fixtures/index.js';
import type { MockClient } from './fixtures/index.js';

const holder = vi.hoisted(() => ({ api: undefined as unknown }));
vi.mock('ynab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ynab')>()),
  API: vi.fn(function () {
    return holder.api;
  }),
}));

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const CATEGORY = '22222222-2222-2222-2222-222222222222';
const PAYEE = '33333333-3333-3333-3333-333333333333';

let mockClient: MockClient;
beforeEach(() => {
  mockClient = createMockClient();
});

const parse = (s: string) => JSON.parse(s) as Record<string, any>;

describe('ynab_list_accounts', () => {
  it('full: same call as before, plus server_knowledge', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse());
    const out = parse(await handleListAccounts({}, mockClient as never));
    expect(mockClient.getAccounts).toHaveBeenCalledWith('test-budget-id');
    expect(out.server_knowledge).toBe(12345);
    expect(out.delta).toBeUndefined();
    expect(out.summary.net_worth).toBeDefined();
  });

  it('delta: changed accounts (closed included), deleted ids, no totals', async () => {
    const [open, closedOne] = [mockAllAccounts[0]!, { ...mockAllAccounts[1]!, closed: true }];
    const gone = { ...mockAllAccounts[2]!, deleted: true };
    mockClient.getAccounts.mockResolvedValue({ data: { accounts: [open, closedOne, gone], server_knowledge: 200 } });
    const out = parse(await handleListAccounts({ since_server_knowledge: 150 }, mockClient as never));
    expect(mockClient.getAccounts).toHaveBeenCalledWith('test-budget-id', { lastKnowledgeOfServer: 150 });
    expect(out).toMatchObject({ delta: true, since_server_knowledge: 150, deleted_ids: [gone.id], server_knowledge: 200 });
    const ids = Object.values(out.accounts_by_type as Record<string, Array<{ id: string }>>).flat().map((a) => a.id);
    expect(ids.sort()).toEqual([open.id, closedOne.id].sort());
    expect(out.summary).toMatchObject({ changed_count: 2, deleted_count: 1 });
    expect(out.summary.net_worth).toBeUndefined();
    expect(out.summary.total_assets).toBeUndefined();
  });

  it.each([-1, 1.5, '10'])('rejects an invalid cursor %s', async (bad) => {
    await expect(handleListAccounts({ since_server_knowledge: bad }, mockClient as never)).rejects.toThrow();
    expect(mockClient.getAccounts).not.toHaveBeenCalled();
  });
});

describe('ynab_list_categories', () => {
  it('full: server_knowledge added', async () => {
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    const out = parse(await handleListCategories({}, mockClient as never));
    expect(mockClient.getCategories).toHaveBeenCalledWith('test-budget-id');
    expect(out.server_knowledge).toBe(12345);
    expect(out.summary.total_budgeted).toBeDefined();
  });

  it('delta: changed groups with changed categories; deleted categories and groups by id', async () => {
    const g = mockCategoryGroups[2]!;
    const [changed, removed] = [g.categories[0]!, { ...g.categories[1]!, deleted: true }];
    const deletedGroup = { ...mockCategoryGroups[3]!, deleted: true, categories: [] };
    mockClient.getCategories.mockResolvedValue({
      data: { category_groups: [{ ...g, categories: [changed, removed] }, deletedGroup], server_knowledge: 77 },
    });
    const out = parse(await handleListCategories({ since_server_knowledge: 70 }, mockClient as never));
    expect(mockClient.getCategories).toHaveBeenCalledWith('test-budget-id', { lastKnowledgeOfServer: 70 });
    expect(out).toMatchObject({
      delta: true,
      since_server_knowledge: 70,
      deleted_ids: [removed.id],
      deleted_group_ids: [deletedGroup.id],
      server_knowledge: 77,
    });
    expect(out.category_groups).toHaveLength(1);
    expect(out.category_groups[0].categories.map((c: { id: string }) => c.id)).toEqual([changed.id]);
    expect(out.summary.total_budgeted).toBeUndefined();
    expect(out.alerts).toBeUndefined();
  });
});

describe('ynab_list_months / ynab_list_payees / ynab_list_scheduled_transactions', () => {
  it('months: full adds server_knowledge; delta lists deleted months', async () => {
    mockClient.getBudgetMonths.mockResolvedValue(createMonthsResponse());
    expect(parse(await handleListMonths({}, mockClient as never)).server_knowledge).toBe(12345);
    expect(mockClient.getBudgetMonths).toHaveBeenLastCalledWith('test-budget-id');

    const [kept, gone] = [mockMonthSummaries[0]!, { ...mockMonthSummaries[1]!, deleted: true }];
    mockClient.getBudgetMonths.mockResolvedValue({ data: { months: [kept, gone], server_knowledge: 9 } });
    const out = parse(await handleListMonths({ since_server_knowledge: 5 }, mockClient as never));
    expect(mockClient.getBudgetMonths).toHaveBeenLastCalledWith('test-budget-id', { lastKnowledgeOfServer: 5 });
    expect(out).toMatchObject({ delta: true, deleted_months: [gone.month], count: 1, server_knowledge: 9 });
  });

  it('payees: delta separates deleted payees', async () => {
    mockClient.getPayees.mockResolvedValue(createPayeesResponse());
    expect(parse(await handleListPayees({}, mockClient as never)).server_knowledge).toBe(12345);

    const gone = { ...mockPayees[1]!, deleted: true };
    mockClient.getPayees.mockResolvedValue({ data: { payees: [mockPayees[0]!, gone], server_knowledge: 3 } });
    const out = parse(await handleListPayees({ since_server_knowledge: 1 }, mockClient as never));
    expect(out).toMatchObject({ delta: true, deleted_ids: [gone.id], summary: { changed_count: 1, deleted_count: 1 } });
    expect(out.summary.total_payees).toBeUndefined();
  });

  it('scheduled: delta omits the estimated monthly total', async () => {
    mockClient.getScheduledTransactions.mockResolvedValue(createScheduledTransactionsResponse());
    const full = parse(await handleListScheduledTransactions({}, mockClient as never));
    expect(full.server_knowledge).toBe(12345);
    expect(full.summary.estimated_monthly_total).toBeDefined();

    const gone = { ...mockScheduledTransactions[0]!, deleted: true };
    mockClient.getScheduledTransactions.mockResolvedValue({ data: { scheduled_transactions: [gone], server_knowledge: 4 } });
    const out = parse(await handleListScheduledTransactions({ since_server_knowledge: 2 }, mockClient as never));
    expect(mockClient.getScheduledTransactions).toHaveBeenLastCalledWith('test-budget-id', { lastKnowledgeOfServer: 2 });
    expect(out).toMatchObject({ delta: true, deleted_ids: [gone.id], scheduled_transactions: [] });
    expect(out.summary.estimated_monthly_total).toBeUndefined();
  });
});

describe('transaction list tools', () => {
  const changed = mockGroceryTransactions[0]!;
  const gone = { ...mockGroceryTransactions[1]!, deleted: true };
  const deltaResponse = { data: { transactions: [changed, gone], server_knowledge: 501 } };

  it('ynab_list_transactions: full output unchanged apart from server_knowledge', async () => {
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse());
    const out = parse(await handleListTransactions({ since_date: '2024-01-01' }, mockClient as never));
    expect(mockClient.getTransactions).toHaveBeenCalledWith('test-budget-id', { sinceDate: '2024-01-01' });
    expect(out.server_knowledge).toBe(12345);
    expect(out.delta).toBeUndefined();
    expect(out.summary.total_inflow).toBeDefined();
  });

  it('ynab_list_transactions: delta passes the cursor with the filters and drops totals', async () => {
    mockClient.getTransactions.mockResolvedValue(deltaResponse);
    const out = parse(
      await handleListTransactions({ since_date: '2024-01-01', type: 'unapproved', since_server_knowledge: 500 }, mockClient as never)
    );
    expect(mockClient.getTransactions).toHaveBeenCalledWith('test-budget-id', {
      sinceDate: '2024-01-01',
      type: 'unapproved',
      lastKnowledgeOfServer: 500,
    });
    expect(out).toMatchObject({ delta: true, since_server_knowledge: 500, deleted_ids: [gone.id], server_knowledge: 501 });
    expect(out.transactions.map((t: { id: string }) => t.id)).toEqual([changed.id]);
    expect(out.summary).toMatchObject({ count: 1, deleted_count: 1 });
    for (const total of ['total_inflow', 'total_outflow', 'net', 'date_range']) expect(out.summary[total]).toBeUndefined();
    expect(out.filters_applied.since_server_knowledge).toBe(500);
  });

  it('ynab_list_transactions: a month query passes the cursor to the month endpoint', async () => {
    mockClient.getTransactionsByMonth.mockResolvedValue(deltaResponse);
    await handleListTransactions({ month: '2024-01-01', since_server_knowledge: 0 }, mockClient as never);
    expect(mockClient.getTransactionsByMonth).toHaveBeenCalledWith('test-budget-id', '2024-01-01', { lastKnowledgeOfServer: 0 });
  });

  it('ynab_list_transactions: a split line reported deleted inside a changed split is not listed', async () => {
    const split = {
      ...changed,
      subtransactions: [
        { id: 's1', transaction_id: changed.id, amount: -1, deleted: false },
        { id: 's2', transaction_id: changed.id, amount: -2, deleted: true },
      ],
    };
    mockClient.getTransactions.mockResolvedValue({ data: { transactions: [split], server_knowledge: 2 } });
    const out = parse(await handleListTransactions({ since_server_knowledge: 1 }, mockClient as never));
    expect(out.transactions[0].subtransactions.map((s: { id: string }) => s.id)).toEqual(['s1']);
  });

  it.each([
    ['account', handleListAccountTransactions, 'getAccountTransactions', { account_id: ACCOUNT }, ACCOUNT, 'total_inflow'],
    ['category', handleListCategoryTransactions, 'getCategoryTransactions', { category_id: CATEGORY }, CATEGORY, 'total_spent'],
    ['payee', handleListPayeeTransactions, 'getPayeeTransactions', { payee_id: PAYEE }, PAYEE, 'total_spent'],
  ] as const)('ynab_list_%s_transactions: full adds server_knowledge; delta marks and drops totals', async (_n, handler, method, args, id, total) => {
    const fn = mockClient[method];
    fn.mockResolvedValue(createTransactionsResponse());
    const full = parse(await handler({ ...args }, mockClient as never));
    expect(fn).toHaveBeenLastCalledWith('test-budget-id', id, { sinceDate: undefined, untilDate: undefined, type: undefined });
    expect(full.server_knowledge).toBe(12345);
    expect(full.summary[total]).toBeDefined();

    fn.mockResolvedValue(deltaResponse);
    const out = parse(await handler({ ...args, since_server_knowledge: 500 }, mockClient as never));
    expect(fn).toHaveBeenLastCalledWith('test-budget-id', id, {
      sinceDate: undefined,
      untilDate: undefined,
      type: undefined,
      lastKnowledgeOfServer: 500,
    });
    expect(out).toMatchObject({ delta: true, deleted_ids: [gone.id], server_knowledge: 501, summary: { count: 1, deleted_count: 1 } });
    expect(out.summary[total]).toBeUndefined();
  });
});

describe('transaction deltas larger than limit', () => {
  const rows = mockGroceryTransactions.slice(0, 3).map((t, i) => ({ ...t, id: `t${i}`, date: `2024-01-0${i + 1}` }));
  const gone = { ...mockGroceryTransactions[0]!, id: 'gone', deleted: true };
  const big = { data: { transactions: [...rows, gone], server_knowledge: 900 } };

  it.each([
    ['transactions', handleListTransactions, 'getTransactions', {}],
    ['account', handleListAccountTransactions, 'getAccountTransactions', { account_id: ACCOUNT }],
    ['category', handleListCategoryTransactions, 'getCategoryTransactions', { category_id: CATEGORY }],
    ['payee', handleListPayeeTransactions, 'getPayeeTransactions', { payee_id: PAYEE }],
  ] as const)('%s: a truncated delta keeps the caller cursor so no change is skipped', async (_n, handler, method, args) => {
    mockClient[method].mockResolvedValue(big);
    const out = parse(await handler({ ...args, limit: 2, since_server_knowledge: 800 }, mockClient as never));
    expect(out.transactions).toHaveLength(2);
    expect(out).toMatchObject({ delta: true, deleted_ids: ['gone'], server_knowledge: 800, cursor_withheld: true });
    expect(out.summary).toMatchObject({ truncated: true, total_count: 3 });
    expect(out.summary.truncation_note).toMatch(/no change is skipped/);
    expect(out.summary.filter_note).toMatch(/no longer matches/);

    // Within the limit: the new cursor, nothing withheld.
    const fits = parse(await handler({ ...args, limit: 3, since_server_knowledge: 800 }, mockClient as never));
    expect(fits).toMatchObject({ server_knowledge: 900, summary: { truncated: false } });
    expect(fits.cursor_withheld).toBeUndefined();
    expect(fits.summary.truncation_note).toBeUndefined();

    // A full (non-cursor) response keeps its server_knowledge even when truncated.
    mockClient[method].mockResolvedValue({ data: { transactions: rows, server_knowledge: 900 } });
    const full = parse(await handler({ ...args, limit: 2 }, mockClient as never));
    expect(full).toMatchObject({ server_knowledge: 900, summary: { truncated: true } });
    expect(full.cursor_withheld).toBeUndefined();
  });
});

describe('end to end: the returned server_knowledge is the next cursor', () => {
  it('ynab_list_transactions full, then delta from its server_knowledge', async () => {
    const fake = new FakeYnab();
    holder.api = fake.api;
    const txn = (id: string, date: string, amount: number) => ({
      id, date, amount, approved: true, account_id: 'A1', category_id: 'c1', payee_id: 'P1', memo: null, deleted: false, subtransactions: [],
    });
    fake.putTransaction(txn('t1', '2026-01-01', -100));
    fake.putTransaction(txn('t2', '2026-01-02', -200));
    const client = new YnabClient('t', FAKE_BUDGET, new RateLimiter(1000), new Cache(300000), true, new AuditLog(), new DeltaCache());

    const full = parse(await handleListTransactions({ since_date: '2025-01-01' }, client));
    expect(full.transactions).toHaveLength(2);
    expect(full.server_knowledge).toBe(fake.knowledge);

    fake.putTransaction(txn('t2', '2026-01-02', -250));
    fake.transactions.remove('t1');
    const delta = parse(
      await handleListTransactions({ since_date: '2025-01-01', since_server_knowledge: full.server_knowledge }, client)
    );
    expect(delta).toMatchObject({ delta: true, deleted_ids: ['t1'], server_knowledge: fake.knowledge });
    expect(delta.transactions.map((t: { id: string; amount: string }) => [t.id, t.amount])).toEqual([['t2', '-$0.25']]);

    // And a plain call afterwards is the full, current list again.
    const again = parse(await handleListTransactions({ since_date: '2025-01-01' }, client));
    expect(again.delta).toBeUndefined();
    expect(again.transactions.map((t: { id: string }) => t.id)).toEqual(['t2']);
  });
});
