/**
 * Structured tool output of the core (non-analytics) tools (#45b).
 *
 * output-schemas.test.ts validates every tool's #44 null-payload fixture
 * output. That fixture has every nullable field null and one shape per tool,
 * so this file runs the core handlers on the realistic mock fixtures and
 * through the branches the fixture never reaches: summary and delta modes,
 * populated optional fields and the in-band failures (`success: false`).
 * Each result is checked against the closed form of its schema, so a field
 * the schema misses fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ZodError } from 'zod';
import { expectValidOutput } from './output-validation.js';
import { getUserOutputSchema, handleGetUser } from '../../../src/tools/user/get-user.js';
import { listBudgetsOutputSchema, handleListBudgets } from '../../../src/tools/budgets/list-budgets.js';
import { getBudgetOutputSchema, handleGetBudget } from '../../../src/tools/budgets/get-budget.js';
import { getBudgetSettingsOutputSchema, handleGetBudgetSettings } from '../../../src/tools/budgets/get-budget-settings.js';
import { listAccountsOutputSchema, handleListAccounts } from '../../../src/tools/accounts/list-accounts.js';
import { getAccountOutputSchema, handleGetAccount } from '../../../src/tools/accounts/get-account.js';
import { createAccountOutputSchema, handleCreateAccount } from '../../../src/tools/accounts/create-account.js';
import { listCategoriesOutputSchema, handleListCategories } from '../../../src/tools/categories/list-categories.js';
import { getCategoryOutputSchema, handleGetCategory } from '../../../src/tools/categories/get-category.js';
import { getMonthCategoryOutputSchema, handleGetMonthCategory } from '../../../src/tools/categories/get-month-category.js';
import { moveMoneyOutputSchema, handleMoveMoney } from '../../../src/tools/categories/move-money.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { listPayeesOutputSchema, handleListPayees } from '../../../src/tools/payees/list-payees.js';
import { listMonthsOutputSchema, handleListMonths } from '../../../src/tools/months/list-months.js';
import { getMonthOutputSchema, handleGetMonth } from '../../../src/tools/months/get-month.js';
import { listTransactionsOutputSchema, handleListTransactions } from '../../../src/tools/transactions/list-transactions.js';
import { getTransactionOutputSchema, handleGetTransaction } from '../../../src/tools/transactions/get-transaction.js';
import { createTransactionOutputSchema, handleCreateTransaction } from '../../../src/tools/transactions/create-transaction.js';
import {
  listAccountTransactionsOutputSchema,
  handleListAccountTransactions,
} from '../../../src/tools/transactions/list-account-transactions.js';
import {
  listCategoryTransactionsOutputSchema,
  handleListCategoryTransactions,
} from '../../../src/tools/transactions/list-category-transactions.js';
import {
  listPayeeTransactionsOutputSchema,
  handleListPayeeTransactions,
} from '../../../src/tools/transactions/list-payee-transactions.js';
import {
  listScheduledTransactionsOutputSchema,
  handleListScheduledTransactions,
} from '../../../src/tools/scheduled-transactions/list-scheduled.js';
import {
  getScheduledTransactionOutputSchema,
  handleGetScheduledTransaction,
} from '../../../src/tools/scheduled-transactions/get-scheduled.js';
import {
  createScheduledTransactionOutputSchema,
  handleCreateScheduledTransaction,
} from '../../../src/tools/scheduled-transactions/create-scheduled.js';
import {
  updateScheduledTransactionOutputSchema,
  handleUpdateScheduledTransaction,
} from '../../../src/tools/scheduled-transactions/update-scheduled.js';
import {
  CircuitOpenError,
  errorResponseSchema,
  formatErrorResponse,
  NotFoundError,
  OutboundTimeoutError,
  RateLimitError,
  ReadOnlyModeError,
  ValidationError,
  WriteLimitError,
  YnabApiError,
  YnabAuthError,
  YnabAuthUnavailableError,
} from '../../../src/utils/errors.js';
import {
  createMockClient,
  createScheduledTransactionsResponse,
  createScheduledTransactionResponse,
  mockScheduledTransactions,
  createTransactionsResponse,
  createHybridTransactionsResponse,
  createTransactionResponse,
  mockAllTransactions,
  mockSplitTransaction,
  mockFlaggedTransaction,
  createMonthsResponse,
  createMonthResponse,
  mockMonthSummaries,
  createPayeesResponse,
  mockPayees,
  mockTransferPayees,
  createCategoriesResponse,
  createCategoryResponse,
  mockBillsCategories,
  mockCategoryGroups,
  createAccountsResponse,
  createAccountResponse,
  mockAllAccounts,
  mockMortgageAccount,
  mockCreditCardWithOverpayment,
  createUserResponse,
  createBudgetsResponse,
  createBudgetResponse,
  createBudgetSettingsResponse,
  mockBudgetSummary,
  mockEurBudgetSummary,
  mockBudgetDetail,
  mockEurCurrencyFormat,
} from './fixtures/index.js';
import type { MockClient } from './fixtures/index.js';

const expectValid = expectValidOutput;
const UUID = '12345678-1234-4234-8234-123456789012';

let client: MockClient;
const c = () => client as never;

beforeEach(() => {
  client = createMockClient();
});

describe('core output schemas: user and budgets', () => {
  it('ynab_get_user', async () => {
    client.getUser.mockResolvedValue(createUserResponse());
    expectValid(getUserOutputSchema, await handleGetUser({}, c()));
  });

  it('ynab_list_budgets: with and without accounts and currency formats', async () => {
    client.getBudgets.mockResolvedValue(createBudgetsResponse([mockBudgetSummary, mockEurBudgetSummary]));
    expectValid(listBudgetsOutputSchema, await handleListBudgets({}, c()));
    const withAccounts = await handleListBudgets({ include_accounts: true }, c());
    expect(withAccounts.budgets[0]!.accounts).toBeDefined();
    expect(withAccounts.budgets[0]!.currency_format).toBeDefined();
    expectValid(listBudgetsOutputSchema, withAccounts);
    client.getBudgets.mockResolvedValue(
      createBudgetsResponse([{ ...mockBudgetSummary, currency_format: null, last_modified_on: undefined, accounts: [] }])
    );
    const bare = await handleListBudgets({}, c());
    expect(bare.budgets[0]).not.toHaveProperty('currency_format');
    expect(bare.budgets[0]).not.toHaveProperty('last_modified');
    expectValid(listBudgetsOutputSchema, bare);
  });

  it('ynab_get_budget: with and without a currency and date format', async () => {
    client.getBudgetById.mockResolvedValue(createBudgetResponse());
    expectValid(getBudgetOutputSchema, await handleGetBudget({}, c()));
    client.getBudgetById.mockResolvedValue(
      createBudgetResponse({ ...mockBudgetDetail, currency_format: null, date_format: null, last_modified_on: undefined } as never)
    );
    expectValid(getBudgetOutputSchema, await handleGetBudget({}, c()));
  });

  it('ynab_get_budget_settings: populated and null formats', async () => {
    client.getBudgetSettingsById.mockResolvedValue(createBudgetSettingsResponse(mockEurCurrencyFormat));
    expectValid(getBudgetSettingsOutputSchema, await handleGetBudgetSettings({}, c()));
    client.getBudgetSettingsById.mockResolvedValue({ data: { settings: { date_format: null, currency_format: null } } });
    expectValid(getBudgetSettingsOutputSchema, await handleGetBudgetSettings({}, c()));
  });
});

describe('core output schemas: accounts', () => {
  it('ynab_list_accounts: full (with liability credits and debt maps), include_closed, and delta', async () => {
    client.getAccounts.mockResolvedValue(createAccountsResponse([...mockAllAccounts, mockCreditCardWithOverpayment]));
    const full = await handleListAccounts({ include_closed: true }, c());
    expect(full.summary.liability_credits).toBeDefined();
    expect(JSON.stringify(full)).toContain('debt_interest_rates_formatted');
    expectValid(listAccountsOutputSchema, full);
    expectValid(listAccountsOutputSchema, await handleListAccounts({}, c()));
    client.getAccounts.mockResolvedValue({
      data: { accounts: [mockAllAccounts[0]!, { ...mockAllAccounts[1]!, deleted: true }], server_knowledge: 20 },
    });
    const delta = await handleListAccounts({ since_server_knowledge: 10 }, c());
    expect(delta.delta).toBe(true);
    expectValid(listAccountsOutputSchema, delta);
  });

  it('ynab_get_account: a debt account', async () => {
    client.getAccountById.mockResolvedValue(createAccountResponse(mockMortgageAccount));
    expectValid(getAccountOutputSchema, await handleGetAccount({ account_id: mockMortgageAccount.id }, c()));
  });

  it('ynab_create_account', async () => {
    client.isReadOnly.mockReturnValue(false);
    client.createAccount.mockResolvedValue(createAccountResponse());
    expectValid(createAccountOutputSchema, await handleCreateAccount({ name: 'A', type: 'checking', balance: 10 }, c()));
  });
});

describe('core output schemas: categories', () => {
  const goalCategory = { ...mockBillsCategories[1]!, goal_cadence: 1, goal_day: 15, goal_snoozed_at: '2024-01-02T00:00:00Z' };

  it('ynab_list_categories: full, include_hidden, and delta with deleted groups and categories', async () => {
    client.getCategories.mockResolvedValue(createCategoriesResponse());
    const full = await handleListCategories({}, c());
    expect(full.alerts).toBeDefined();
    expect(full.category_groups.some((g) => g.categories.some((x) => x.goal !== null))).toBe(true);
    expectValid(listCategoriesOutputSchema, full);
    expectValid(listCategoriesOutputSchema, await handleListCategories({ include_hidden: true }, c()));
    const [first, second] = mockCategoryGroups;
    client.getCategories.mockResolvedValue({
      data: {
        category_groups: [
          { ...first!, categories: [goalCategory, { ...first!.categories[0]!, deleted: true }] },
          { ...second!, deleted: true },
        ],
        server_knowledge: 20,
      },
    });
    const delta = await handleListCategories({ since_server_knowledge: 10 }, c());
    expect(delta.deleted_group_ids).toHaveLength(1);
    expect(delta).not.toHaveProperty('alerts');
    expectValid(listCategoriesOutputSchema, delta);
  });

  it('ynab_get_category and ynab_get_month_category: a category with a repeating, snoozed target', async () => {
    client.getCategoryById.mockResolvedValue(createCategoryResponse({ ...goalCategory, original_category_group_id: 'group-0' } as never));
    const got = await handleGetCategory({ category_id: UUID }, c());
    expect(got.category.goal?.cadence).not.toBeNull();
    expect(got.category.original_category_group_id).toBe('group-0');
    expectValid(getCategoryOutputSchema, got);
    client.getMonthCategoryById.mockResolvedValue(createCategoryResponse(goalCategory));
    expectValid(
      getMonthCategoryOutputSchema,
      await handleGetMonthCategory({ category_id: UUID, month: '2024-01-01' }, c())
    );
  });

  it("ynab_move_money: the cause of a failure, whatever error the update raised", async () => {
    const FROM = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const TO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const cat = (id: string, budgeted: number) => ({ data: { category: { id, name: id === FROM ? 'A' : 'B', budgeted, activity: 0, balance: 0 } } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.isReadOnly.mockReturnValue(false);
    Object.assign(client, { getAuditLog: () => new AuditLog() });
    for (const error of [new OutboundTimeoutError(true), new YnabApiError('x', '500', undefined, 30), new Error('boom')]) {
      client.getMonthCategoryById.mockReset();
      client.updateMonthCategory.mockReset();
      // Leg 2 fails and "to" re-reads unchanged; the rollback succeeds.
      client.getMonthCategoryById
        .mockResolvedValueOnce(cat(FROM, 200000))
        .mockResolvedValueOnce(cat(TO, 300000))
        .mockResolvedValueOnce(cat(TO, 300000))
        .mockResolvedValueOnce(cat(FROM, 150000));
      client.updateMonthCategory
        .mockResolvedValueOnce(cat(FROM, 150000))
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(cat(FROM, 200000));
      const out = await handleMoveMoney({ month: '2024-03-01', from_category_id: FROM, to_category_id: TO, amount: 50 }, c());
      expect(out.type).toBe('move_failed_rolled_back');
      expect(out.cause).toBeDefined();
      expectValid(moveMoneyOutputSchema, out);
    }
  });

  it('errorResponseSchema describes every branch of formatErrorResponse (move_money embeds it as cause)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let zodError: unknown;
    try {
      errorResponseSchema.parse({});
    } catch (e) {
      zodError = e;
    }
    expect(zodError).toBeInstanceOf(ZodError);
    const errors: unknown[] = [
      new ReadOnlyModeError('x'),
      new YnabAuthUnavailableError(5),
      new WriteLimitError(10, Date.UTC(2026, 0, 1), 1500),
      new YnabAuthError(),
      new RateLimitError(2500),
      new RateLimitError(),
      new OutboundTimeoutError(true),
      new OutboundTimeoutError(false),
      new CircuitOpenError(1000),
      new ValidationError('bad', 'amount'),
      new ValidationError('bad'),
      new NotFoundError('account', 'x'),
      new YnabApiError('x', '429', undefined, 60),
      new YnabApiError('x', '404'),
      { error: { id: '404', detail: 'gone' } },
      zodError,
      new Error('boom'),
    ];
    for (const error of errors) expectValid(errorResponseSchema, JSON.parse(formatErrorResponse(error)));
  });
});

describe('core output schemas: payees', () => {
  it('ynab_list_payees: full with transfer payees, and delta', async () => {
    client.getPayees.mockResolvedValue(createPayeesResponse());
    const full = await handleListPayees({}, c());
    expect(full.transfer_payees.length).toBeGreaterThan(0);
    expectValid(listPayeesOutputSchema, full);
    client.getPayees.mockResolvedValue({
      data: { payees: [mockPayees[0]!, mockTransferPayees[0]!, { ...mockPayees[1]!, deleted: true }], server_knowledge: 20 },
    });
    const delta = await handleListPayees({ since_server_knowledge: 10 }, c());
    expect(delta.deleted_ids).toHaveLength(1);
    expectValid(listPayeesOutputSchema, delta);
  });
});

describe('core output schemas: months', () => {
  it('ynab_list_months: full and delta (deleted months by month)', async () => {
    client.getBudgetMonths.mockResolvedValue(createMonthsResponse());
    expectValid(listMonthsOutputSchema, await handleListMonths({}, c()));
    client.getBudgetMonths.mockResolvedValue({
      data: { months: [mockMonthSummaries[0]!, { ...mockMonthSummaries[1]!, deleted: true }], server_knowledge: 20 },
    });
    const delta = await handleListMonths({ since_server_knowledge: 10 }, c());
    expect(delta.deleted_months).toHaveLength(1);
    expectValid(listMonthsOutputSchema, delta);
  });

  it('ynab_get_month: with age of money', async () => {
    client.getBudgetMonth.mockResolvedValue(createMonthResponse());
    client.getCategories.mockResolvedValue(createCategoriesResponse());
    const out = await handleGetMonth({ month: '2024-01-01' }, c());
    expect(out.summary.age_of_money).toBeDefined();
    expectValid(getMonthOutputSchema, out);
  });
});

describe('core output schemas: transactions', () => {
  const deleted = { ...mockAllTransactions[0]!, deleted: true };
  const delta = (rows: unknown[]) => ({ data: { transactions: rows, server_knowledge: 900 } });
  const listTools = [
    ['ynab_list_transactions', handleListTransactions, listTransactionsOutputSchema, 'getTransactions', {}, false],
    [
      'ynab_list_account_transactions',
      handleListAccountTransactions,
      listAccountTransactionsOutputSchema,
      'getAccountTransactions',
      { account_id: UUID },
      false,
    ],
    [
      'ynab_list_category_transactions',
      handleListCategoryTransactions,
      listCategoryTransactionsOutputSchema,
      'getCategoryTransactions',
      { category_id: UUID },
      true,
    ],
    [
      'ynab_list_payee_transactions',
      handleListPayeeTransactions,
      listPayeeTransactionsOutputSchema,
      'getPayeeTransactions',
      { payee_id: UUID },
      true,
    ],
  ] as const;

  it.each(listTools)('%s: full, filtered, delta, and a delta truncated by limit', async (_name, handler, schema, method, args, hybrid) => {
    const response = hybrid ? createHybridTransactionsResponse : createTransactionsResponse;
    const rows = response([...mockAllTransactions, mockSplitTransaction]).data.transactions;
    client[method].mockResolvedValue(response([...mockAllTransactions, mockSplitTransaction]));
    expectValid(schema, await handler({ ...args }, c()));
    expectValid(schema, await handler({ ...args, since_date: '2024-01-01', until_date: '2024-12-31', type: 'unapproved', limit: 2 }, c()));
    client[method].mockResolvedValue(delta([...rows.slice(0, 3), deleted]));
    const changed = (await handler({ ...args, since_server_knowledge: 800 }, c())) as Record<string, unknown>;
    expect(changed['delta']).toBe(true);
    expectValid(schema, changed);
    const cut = (await handler({ ...args, since_server_knowledge: 800, limit: 1 }, c())) as Record<string, unknown>;
    expect(cut['cursor_withheld']).toBe(true);
    expectValid(schema, cut);
  });

  it('ynab_list_category_transactions and ynab_list_payee_transactions: without server_knowledge (hybrid responses may lack it)', async () => {
    const rows = createHybridTransactionsResponse().data.transactions;
    client.getCategoryTransactions.mockResolvedValue({ data: { transactions: rows } });
    const out = await handleListCategoryTransactions({ category_id: UUID }, c());
    expect(out).not.toHaveProperty('server_knowledge');
    expectValid(listCategoryTransactionsOutputSchema, out);
    client.getPayeeTransactions.mockResolvedValue({ data: { transactions: rows } });
    expectValid(listPayeeTransactionsOutputSchema, await handleListPayeeTransactions({ payee_id: UUID }, c()));
  });

  it('ynab_list_transactions: by month', async () => {
    client.getTransactionsByMonth.mockResolvedValue(createTransactionsResponse());
    expectValid(listTransactionsOutputSchema, await handleListTransactions({ month: '2024-01-01' }, c()));
  });

  it('ynab_get_transaction: a split, and a flagged transaction', async () => {
    client.getTransactionById.mockResolvedValue(createTransactionResponse(mockSplitTransaction));
    const split = await handleGetTransaction({ transaction_id: UUID }, c());
    expect(split.transaction.subtransactions.length).toBeGreaterThan(0);
    expectValid(getTransactionOutputSchema, split);
    client.getTransactionById.mockResolvedValue(createTransactionResponse(mockFlaggedTransaction));
    expectValid(getTransactionOutputSchema, await handleGetTransaction({ transaction_id: UUID }, c()));
  });

  it('ynab_create_transaction: a split, and the in-band duplicate import_id result', async () => {
    client.isReadOnly.mockReturnValue(false);
    client.createTransaction.mockResolvedValue(createTransactionResponse(mockSplitTransaction));
    const created = await handleCreateTransaction({ account_id: UUID, date: '2024-01-20', amount: -150 }, c());
    expect(created.transaction?.subtransactions).toBeDefined();
    expectValid(createTransactionOutputSchema, created);
    client.createTransaction.mockResolvedValue({ data: { transactions: [], duplicate_import_ids: ['dup-1'] } });
    const dup = await handleCreateTransaction({ account_id: UUID, date: '2024-01-20', amount: -1, import_id: 'dup-1' }, c());
    expect(dup.success).toBe(false);
    expectValid(createTransactionOutputSchema, dup);
  });
});

describe('core output schemas: scheduled transactions', () => {
  const withSplits = {
    ...mockScheduledTransactions[0]!,
    flag_color: 'red',
    payee_id: 'p1',
    category_id: null,
    subtransactions: [
      { id: 's1', scheduled_transaction_id: mockScheduledTransactions[0]!.id, amount: -1000, memo: 'a', payee_id: null, category_id: 'c1', transfer_account_id: null, deleted: false },
      { id: 's2', scheduled_transaction_id: mockScheduledTransactions[0]!.id, amount: -500, memo: null, payee_id: 'p2', category_id: null, transfer_account_id: 'acc', deleted: false },
    ],
  };

  it('ynab_list_scheduled_transactions: full with splits and flags, and delta', async () => {
    client.getScheduledTransactions.mockResolvedValue(createScheduledTransactionsResponse([...mockScheduledTransactions, withSplits] as never));
    const full = await handleListScheduledTransactions({}, c());
    expect(full.summary.by_frequency).toBeDefined();
    expectValid(listScheduledTransactionsOutputSchema, full);
    client.getScheduledTransactions.mockResolvedValue({
      data: { scheduled_transactions: [withSplits, { ...mockScheduledTransactions[1]!, deleted: true }], server_knowledge: 9 },
    });
    const delta = await handleListScheduledTransactions({ since_server_knowledge: 5 }, c());
    expect(delta.deleted_ids).toHaveLength(1);
    expectValid(listScheduledTransactionsOutputSchema, delta);
  });

  it('ynab_get_scheduled_transaction: with splits and a transfer', async () => {
    client.getScheduledTransactionById.mockResolvedValue(createScheduledTransactionResponse({ ...withSplits, transfer_account_id: 'acc' } as never));
    expectValid(getScheduledTransactionOutputSchema, await handleGetScheduledTransaction({ scheduled_transaction_id: UUID }, c()));
  });

  it('ynab_create_ and ynab_update_scheduled_transaction: the in-band refusals (success: false)', async () => {
    client.isReadOnly.mockReturnValue(false);
    const past = { account_id: UUID, date: '2000-01-01', amount: -5, frequency: 'monthly', payee_name: 'Rent' };
    const refused = await handleCreateScheduledTransaction(past, c());
    expect(refused.success).toBe(false);
    expectValid(createScheduledTransactionOutputSchema, refused);
    const badDate = await handleUpdateScheduledTransaction({ scheduled_transaction_id: UUID, date: '2000-01-01' }, c());
    expect(badDate.success).toBe(false);
    expectValid(updateScheduledTransactionOutputSchema, badDate);
    const nothing = await handleUpdateScheduledTransaction({ scheduled_transaction_id: UUID }, c());
    expect(nothing).toEqual({ success: false, error: 'No fields provided to update' });
    expectValid(updateScheduledTransactionOutputSchema, nothing);
    expect(client.createScheduledTransaction).not.toHaveBeenCalled();
    expect(client.updateScheduledTransaction).not.toHaveBeenCalled();
  });
});
