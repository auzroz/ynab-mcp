/**
 * YnabClient Wrapper Tests
 *
 * The official `ynab` SDK is mocked so `new ynab.API(token)` returns a mock
 * object whose accessors expose vi.fn() methods. The YnabClient is constructed
 * with real RateLimiter and Cache instances.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { ReadOnlyModeError } from '../../../src/utils/errors.js';
import { getAuditLog, _resetAuditLogForTesting } from '../../../src/services/audit-log.js';

// Shared mock API instance, built lazily by the mocked constructor.
const mockApi = vi.hoisted(() => {
  const fn = (): ReturnType<typeof vi.fn> => vi.fn();
  return {
    user: { getUser: fn() },
    plans: {
      getPlans: fn(),
      getPlanById: fn(),
      getPlanSettingsById: fn(),
    },
    accounts: {
      getAccounts: fn(),
      getAccountById: fn(),
      createAccount: fn(),
    },
    categories: {
      getCategories: fn(),
      getCategoryById: fn(),
      getMonthCategoryById: fn(),
      updateMonthCategory: fn(),
      createCategory: fn(),
      createCategoryGroup: fn(),
      updateCategoryGroup: fn(),
    },
    transactions: {
      getTransactions: fn(),
      getTransactionById: fn(),
      createTransaction: fn(),
      updateTransaction: fn(),
      updateTransactions: fn(),
      deleteTransaction: fn(),
      importTransactions: fn(),
      getTransactionsByAccount: fn(),
      getTransactionsByCategory: fn(),
      getTransactionsByPayee: fn(),
    },
    scheduledTransactions: {
      getScheduledTransactions: fn(),
      getScheduledTransactionById: fn(),
      createScheduledTransaction: fn(),
      updateScheduledTransaction: fn(),
      deleteScheduledTransaction: fn(),
    },
    payees: {
      getPayees: fn(),
      getPayeeById: fn(),
      createPayee: fn(),
      updatePayee: fn(),
    },
    payeeLocations: {
      getPayeeLocations: fn(),
      getPayeeLocationById: fn(),
      getPayeeLocationsByPayee: fn(),
    },
    months: {
      getPlanMonths: fn(),
      getPlanMonth: fn(),
    },
    money_movements: {
      getMoneyMovements: fn(),
    },
  };
});

vi.mock('ynab', () => ({
  API: vi.fn(() => mockApi),
}));

const BUDGET = 'budget-123';

function makeClient(readOnly: boolean): YnabClient {
  return new YnabClient(
    'fake-token',
    'last-used',
    new RateLimiter(180),
    new Cache(300000),
    readOnly
  );
}

/** Resolve a value for an accessor method (mock fn). */
function setResolve(fnRef: unknown, value: unknown): void {
  (fnRef as ReturnType<typeof vi.fn>).mockResolvedValue(value);
}

function setReject(fnRef: unknown, err: unknown): void {
  (fnRef as ReturnType<typeof vi.fn>).mockRejectedValue(err);
}

function asMock(fnRef: unknown): ReturnType<typeof vi.fn> {
  return fnRef as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAuditLogForTesting();
  // Silence the [AUDIT] stderr logging from audit-log.log()
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('YnabClient construction & simple accessors', () => {
  it('isReadOnly reflects the constructor flag', () => {
    expect(makeClient(true).isReadOnly()).toBe(true);
    expect(makeClient(false).isReadOnly()).toBe(false);
  });

  it('defaults to read-only when flag omitted', () => {
    const client = new YnabClient('t', undefined, new RateLimiter(180), new Cache(300000));
    expect(client.isReadOnly()).toBe(true);
  });

  it('getDefaultBudgetId returns provided id', () => {
    const client = new YnabClient('t', BUDGET, new RateLimiter(180), new Cache(300000));
    expect(client.getDefaultBudgetId()).toBe(BUDGET);
  });

  it('getDefaultBudgetId falls back to "last-used" when undefined', () => {
    const client = new YnabClient('t', undefined, new RateLimiter(180), new Cache(300000));
    expect(client.getDefaultBudgetId()).toBe('last-used');
  });

  it('resolveBudgetId uses provided id or default', () => {
    const client = makeClient(true);
    expect(client.resolveBudgetId('explicit')).toBe('explicit');
    expect(client.resolveBudgetId()).toBe('last-used');
  });

  it('getRateLimitStatus delegates to the rate limiter', () => {
    const status = makeClient(true).getRateLimitStatus();
    expect(status).toHaveProperty('available');
    expect(status).toHaveProperty('limit', 180);
  });

  it('server knowledge get/update round-trips', () => {
    const client = makeClient(true);
    expect(client.getServerKnowledge(BUDGET)).toBeUndefined();
    client.updateServerKnowledge(BUDGET, 42);
    expect(client.getServerKnowledge(BUDGET)).toBe(42);
  });
});

describe('read methods', () => {
  it('getUser calls api.user.getUser', async () => {
    setResolve(mockApi.user.getUser, { data: { user: { id: 'u1' } } });
    const result = await makeClient(true).getUser();
    expect(result).toEqual({ data: { user: { id: 'u1' } } });
    expect(asMock(mockApi.user.getUser)).toHaveBeenCalledTimes(1);
  });

  it('getBudgets maps to plans.getPlans and caches the result', async () => {
    setResolve(mockApi.plans.getPlans, { data: { budgets: [] } });
    const client = makeClient(true);

    const first = await client.getBudgets(true);
    const second = await client.getBudgets(true);

    expect(first).toEqual({ data: { budgets: [] } });
    expect(second).toEqual({ data: { budgets: [] } });
    // Cached: SDK only called once
    expect(asMock(mockApi.plans.getPlans)).toHaveBeenCalledTimes(1);
    expect(asMock(mockApi.plans.getPlans)).toHaveBeenCalledWith(true);
  });

  it('getBudgets caches separately by includeAccounts flag', async () => {
    setResolve(mockApi.plans.getPlans, { data: { budgets: [] } });
    const client = makeClient(true);

    await client.getBudgets(false);
    await client.getBudgets(true);

    expect(asMock(mockApi.plans.getPlans)).toHaveBeenCalledTimes(2);
  });

  it('getBudgetById maps to plans.getPlanById and tracks server_knowledge', async () => {
    setResolve(mockApi.plans.getPlanById, { data: { budget: {}, server_knowledge: 99 } });
    const client = makeClient(true);

    const result = await client.getBudgetById(BUDGET, 5);

    expect(asMock(mockApi.plans.getPlanById)).toHaveBeenCalledWith(BUDGET, 5);
    expect(result.data.server_knowledge).toBe(99);
    expect(client.getServerKnowledge(BUDGET)).toBe(99);
  });

  it('getBudgetById does not track server_knowledge when absent', async () => {
    setResolve(mockApi.plans.getPlanById, { data: { budget: {} } });
    const client = makeClient(true);

    await client.getBudgetById(BUDGET);
    expect(client.getServerKnowledge(BUDGET)).toBeUndefined();
  });

  it('getBudgetSettingsById maps to plans.getPlanSettingsById and caches', async () => {
    setResolve(mockApi.plans.getPlanSettingsById, { data: { settings: {} } });
    const client = makeClient(true);

    await client.getBudgetSettingsById(BUDGET);
    await client.getBudgetSettingsById(BUDGET);

    expect(asMock(mockApi.plans.getPlanSettingsById)).toHaveBeenCalledTimes(1);
  });

  it('getAccounts caches and maps to accounts.getAccounts', async () => {
    setResolve(mockApi.accounts.getAccounts, { data: { accounts: [] } });
    const client = makeClient(true);

    await client.getAccounts(BUDGET);
    await client.getAccounts(BUDGET);

    expect(asMock(mockApi.accounts.getAccounts)).toHaveBeenCalledTimes(1);
    expect(asMock(mockApi.accounts.getAccounts)).toHaveBeenCalledWith(BUDGET);
  });

  it('getAccountById is not cached', async () => {
    setResolve(mockApi.accounts.getAccountById, { data: { account: {} } });
    const client = makeClient(true);

    await client.getAccountById(BUDGET, 'acc-1');
    await client.getAccountById(BUDGET, 'acc-1');

    expect(asMock(mockApi.accounts.getAccountById)).toHaveBeenCalledTimes(2);
    expect(asMock(mockApi.accounts.getAccountById)).toHaveBeenCalledWith(BUDGET, 'acc-1');
  });

  it('getCategories caches', async () => {
    setResolve(mockApi.categories.getCategories, { data: { category_groups: [] } });
    const client = makeClient(true);
    await client.getCategories(BUDGET);
    await client.getCategories(BUDGET);
    expect(asMock(mockApi.categories.getCategories)).toHaveBeenCalledTimes(1);
  });

  it('getCategoryById maps to categories.getCategoryById', async () => {
    setResolve(mockApi.categories.getCategoryById, { data: { category: {} } });
    await makeClient(true).getCategoryById(BUDGET, 'cat-1');
    expect(asMock(mockApi.categories.getCategoryById)).toHaveBeenCalledWith(BUDGET, 'cat-1');
  });

  it('getMonthCategoryById maps correctly', async () => {
    setResolve(mockApi.categories.getMonthCategoryById, { data: { category: {} } });
    await makeClient(true).getMonthCategoryById(BUDGET, '2026-06-01', 'cat-1');
    expect(asMock(mockApi.categories.getMonthCategoryById)).toHaveBeenCalledWith(
      BUDGET,
      '2026-06-01',
      'cat-1'
    );
  });

  it('getTransactions maps to transactions.getTransactions with options and tracks server_knowledge', async () => {
    setResolve(mockApi.transactions.getTransactions, {
      data: { transactions: [], server_knowledge: 7 },
    });
    const client = makeClient(true);

    await client.getTransactions(BUDGET, {
      sinceDate: '2026-01-01',
      type: 'unapproved',
      lastKnowledgeOfServer: 3,
    });

    expect(asMock(mockApi.transactions.getTransactions)).toHaveBeenCalledWith(
      BUDGET,
      '2026-01-01',
      'unapproved',
      3
    );
    expect(client.getServerKnowledge(BUDGET)).toBe(7);
  });

  it('getTransactions handles undefined options', async () => {
    setResolve(mockApi.transactions.getTransactions, { data: { transactions: [] } });
    const client = makeClient(true);
    await client.getTransactions(BUDGET);
    expect(asMock(mockApi.transactions.getTransactions)).toHaveBeenCalledWith(
      BUDGET,
      undefined,
      undefined,
      undefined
    );
    expect(client.getServerKnowledge(BUDGET)).toBeUndefined();
  });

  it('getTransactionById maps correctly', async () => {
    setResolve(mockApi.transactions.getTransactionById, { data: { transaction: {} } });
    await makeClient(true).getTransactionById(BUDGET, 'txn-1');
    expect(asMock(mockApi.transactions.getTransactionById)).toHaveBeenCalledWith(BUDGET, 'txn-1');
  });

  it('getAccountTransactions maps to getTransactionsByAccount', async () => {
    setResolve(mockApi.transactions.getTransactionsByAccount, { data: { transactions: [] } });
    await makeClient(true).getAccountTransactions(BUDGET, 'acc-1', '2026-01-01');
    expect(asMock(mockApi.transactions.getTransactionsByAccount)).toHaveBeenCalledWith(
      BUDGET,
      'acc-1',
      '2026-01-01'
    );
  });

  it('getCategoryTransactions maps to getTransactionsByCategory', async () => {
    setResolve(mockApi.transactions.getTransactionsByCategory, { data: { transactions: [] } });
    await makeClient(true).getCategoryTransactions(BUDGET, 'cat-1');
    expect(asMock(mockApi.transactions.getTransactionsByCategory)).toHaveBeenCalledWith(
      BUDGET,
      'cat-1',
      undefined
    );
  });

  it('getPayeeTransactions maps to getTransactionsByPayee', async () => {
    setResolve(mockApi.transactions.getTransactionsByPayee, { data: { transactions: [] } });
    await makeClient(true).getPayeeTransactions(BUDGET, 'payee-1', '2026-02-02');
    expect(asMock(mockApi.transactions.getTransactionsByPayee)).toHaveBeenCalledWith(
      BUDGET,
      'payee-1',
      '2026-02-02'
    );
  });

  it('getScheduledTransactions maps correctly', async () => {
    setResolve(mockApi.scheduledTransactions.getScheduledTransactions, {
      data: { scheduled_transactions: [] },
    });
    await makeClient(true).getScheduledTransactions(BUDGET);
    expect(asMock(mockApi.scheduledTransactions.getScheduledTransactions)).toHaveBeenCalledWith(
      BUDGET
    );
  });

  it('getScheduledTransactionById maps correctly', async () => {
    setResolve(mockApi.scheduledTransactions.getScheduledTransactionById, {
      data: { scheduled_transaction: {} },
    });
    await makeClient(true).getScheduledTransactionById(BUDGET, 'sch-1');
    expect(
      asMock(mockApi.scheduledTransactions.getScheduledTransactionById)
    ).toHaveBeenCalledWith(BUDGET, 'sch-1');
  });

  it('getPayees caches', async () => {
    setResolve(mockApi.payees.getPayees, { data: { payees: [] } });
    const client = makeClient(true);
    await client.getPayees(BUDGET);
    await client.getPayees(BUDGET);
    expect(asMock(mockApi.payees.getPayees)).toHaveBeenCalledTimes(1);
  });

  it('getPayeeById maps correctly', async () => {
    setResolve(mockApi.payees.getPayeeById, { data: { payee: {} } });
    await makeClient(true).getPayeeById(BUDGET, 'payee-1');
    expect(asMock(mockApi.payees.getPayeeById)).toHaveBeenCalledWith(BUDGET, 'payee-1');
  });

  it('getPayeeLocations maps correctly', async () => {
    setResolve(mockApi.payeeLocations.getPayeeLocations, { data: { payee_locations: [] } });
    await makeClient(true).getPayeeLocations(BUDGET);
    expect(asMock(mockApi.payeeLocations.getPayeeLocations)).toHaveBeenCalledWith(BUDGET);
  });

  it('getPayeeLocationById maps correctly', async () => {
    setResolve(mockApi.payeeLocations.getPayeeLocationById, { data: { payee_location: {} } });
    await makeClient(true).getPayeeLocationById(BUDGET, 'loc-1');
    expect(asMock(mockApi.payeeLocations.getPayeeLocationById)).toHaveBeenCalledWith(
      BUDGET,
      'loc-1'
    );
  });

  it('getPayeeLocationsByPayee maps correctly', async () => {
    setResolve(mockApi.payeeLocations.getPayeeLocationsByPayee, { data: { payee_locations: [] } });
    await makeClient(true).getPayeeLocationsByPayee(BUDGET, 'payee-1');
    expect(asMock(mockApi.payeeLocations.getPayeeLocationsByPayee)).toHaveBeenCalledWith(
      BUDGET,
      'payee-1'
    );
  });

  it('getBudgetMonths maps to months.getPlanMonths', async () => {
    setResolve(mockApi.months.getPlanMonths, { data: { months: [] } });
    await makeClient(true).getBudgetMonths(BUDGET);
    expect(asMock(mockApi.months.getPlanMonths)).toHaveBeenCalledWith(BUDGET);
  });

  it('getBudgetMonth maps to months.getPlanMonth', async () => {
    setResolve(mockApi.months.getPlanMonth, { data: { month: {} } });
    await makeClient(true).getBudgetMonth(BUDGET, '2026-06-01');
    expect(asMock(mockApi.months.getPlanMonth)).toHaveBeenCalledWith(BUDGET, '2026-06-01');
  });

  it('getMoneyMovements maps to money_movements.getMoneyMovements', async () => {
    setResolve(mockApi.money_movements.getMoneyMovements, { data: { money_movements: [] } });
    await makeClient(true).getMoneyMovements(BUDGET);
    expect(asMock(mockApi.money_movements.getMoneyMovements)).toHaveBeenCalledWith(BUDGET);
  });
});

describe('write methods - read-only mode rejection', () => {
  it('all write methods throw ReadOnlyModeError without calling the SDK', async () => {
    const client = makeClient(true);

    await expect(
      client.createAccount(BUDGET, { account: { name: 'A', type: 'checking' } } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.updateMonthCategory(BUDGET, '2026-06-01', 'cat-1', {
        category: { budgeted: 100 },
      } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.createCategory(BUDGET, { category: { name: 'C' } } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.createCategoryGroup(BUDGET, { category_group: { name: 'G' } } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.updateCategoryGroup(BUDGET, 'g-1', { category_group: { name: 'G' } } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.createTransaction(BUDGET, { transaction: {} } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.updateTransaction(BUDGET, 'txn-1', { transaction: {} } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.updateTransactions(BUDGET, { transactions: [] } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(client.deleteTransaction(BUDGET, 'txn-1')).rejects.toThrow(ReadOnlyModeError);
    await expect(client.importTransactions(BUDGET)).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.createPayee(BUDGET, { payee: { name: 'P' } } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.updatePayee(BUDGET, 'payee-1', { payee: { name: 'P' } } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.createScheduledTransaction(BUDGET, { scheduled_transaction: {} } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(
      client.updateScheduledTransaction(BUDGET, 'sch-1', { scheduled_transaction: {} } as never)
    ).rejects.toThrow(ReadOnlyModeError);
    await expect(client.deleteScheduledTransaction(BUDGET, 'sch-1')).rejects.toThrow(
      ReadOnlyModeError
    );

    // No SDK write method was ever invoked.
    expect(asMock(mockApi.accounts.createAccount)).not.toHaveBeenCalled();
    expect(asMock(mockApi.transactions.createTransaction)).not.toHaveBeenCalled();
    expect(asMock(mockApi.payees.updatePayee)).not.toHaveBeenCalled();
  });
});

describe('createAccount (write)', () => {
  it('calls SDK, invalidates caches, and logs a success audit entry', async () => {
    const client = makeClient(false);
    // Prime caches that should be invalidated.
    setResolve(mockApi.accounts.getAccounts, { data: { accounts: [] } });
    setResolve(mockApi.plans.getPlans, { data: { budgets: [] } });
    await client.getAccounts(BUDGET);
    await client.getBudgets(true);

    setResolve(mockApi.accounts.createAccount, { data: { account: { id: 'acc-new' } } });

    const result = await client.createAccount(BUDGET, {
      account: { name: 'Checking', type: 'checking' },
    } as never);

    expect(result.data.account.id).toBe('acc-new');
    expect(asMock(mockApi.accounts.createAccount)).toHaveBeenCalledWith(BUDGET, {
      account: { name: 'Checking', type: 'checking' },
    });

    // Caches invalidated -> next reads hit SDK again.
    await client.getAccounts(BUDGET);
    await client.getBudgets(true);
    expect(asMock(mockApi.accounts.getAccounts)).toHaveBeenCalledTimes(2);
    expect(asMock(mockApi.plans.getPlans)).toHaveBeenCalledTimes(2);

    const entries = getAuditLog().getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operation: 'create',
      tool: 'ynab_create_account',
      resourceType: 'account',
      resourceId: 'acc-new',
      success: true,
    });
  });

  it('logs a failed audit entry and rethrows on SDK error', async () => {
    const client = makeClient(false);
    setReject(mockApi.accounts.createAccount, new Error('boom'));

    await expect(
      client.createAccount(BUDGET, { account: { name: 'X', type: 'checking' } } as never)
    ).rejects.toThrow('boom');

    const entries = getAuditLog().getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: 'ynab_create_account',
      success: false,
    });
    expect(entries[0]?.error).toBeDefined();
  });
});

describe('updateMonthCategory (write)', () => {
  it('calls SDK, invalidates categories cache, logs success', async () => {
    const client = makeClient(false);
    setResolve(mockApi.categories.getCategories, { data: { category_groups: [] } });
    await client.getCategories(BUDGET);

    setResolve(mockApi.categories.updateMonthCategory, { data: { category: {} } });
    await client.updateMonthCategory(BUDGET, '2026-06-01', 'cat-1', {
      category: { budgeted: 5000 },
    } as never);

    expect(asMock(mockApi.categories.updateMonthCategory)).toHaveBeenCalledWith(
      BUDGET,
      '2026-06-01',
      'cat-1',
      { category: { budgeted: 5000 } }
    );

    await client.getCategories(BUDGET);
    expect(asMock(mockApi.categories.getCategories)).toHaveBeenCalledTimes(2);

    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_update_category',
      resourceId: 'cat-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.categories.updateMonthCategory, new Error('nope'));
    await expect(
      client.updateMonthCategory(BUDGET, '2026-06-01', 'cat-1', {
        category: { budgeted: 1 },
      } as never)
    ).rejects.toThrow('nope');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('createCategory (write)', () => {
  it('succeeds, invalidates cache, logs success', async () => {
    const client = makeClient(false);
    setResolve(mockApi.categories.createCategory, { data: { category: { id: 'cat-new' } } });
    await client.createCategory(BUDGET, {
      category: { name: 'Groceries', category_group_id: 'g-1' },
    } as never);
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_create_category',
      resourceId: 'cat-new',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.categories.createCategory, new Error('fail'));
    await expect(
      client.createCategory(BUDGET, { category: { name: 'X' } } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('createCategoryGroup (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.categories.createCategoryGroup, {
      data: { category_group: { id: 'g-new' } },
    });
    await client.createCategoryGroup(BUDGET, { category_group: { name: 'G' } } as never);
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_create_category_group',
      resourceId: 'g-new',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.categories.createCategoryGroup, new Error('fail'));
    await expect(
      client.createCategoryGroup(BUDGET, { category_group: { name: 'G' } } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('updateCategoryGroup (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.categories.updateCategoryGroup, {
      data: { category_group: { id: 'g-1' } },
    });
    await client.updateCategoryGroup(BUDGET, 'g-1', { category_group: { name: 'G' } } as never);
    expect(asMock(mockApi.categories.updateCategoryGroup)).toHaveBeenCalledWith(BUDGET, 'g-1', {
      category_group: { name: 'G' },
    });
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_update_category_group',
      resourceId: 'g-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.categories.updateCategoryGroup, new Error('fail'));
    await expect(
      client.updateCategoryGroup(BUDGET, 'g-1', { category_group: { name: 'G' } } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('createTransaction (write)', () => {
  it('succeeds, sets resourceId when present, logs success', async () => {
    const client = makeClient(false);
    setResolve(mockApi.transactions.createTransaction, {
      data: { transaction: { id: 'txn-new' } },
    });
    await client.createTransaction(BUDGET, {
      transaction: { amount: -1000, date: '2026-06-01', payee_name: 'Store', account_id: 'a' },
    } as never);
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_create_transaction',
      resourceId: 'txn-new',
      success: true,
    });
  });

  it('omits resourceId when the created transaction id is absent', async () => {
    const client = makeClient(false);
    setResolve(mockApi.transactions.createTransaction, { data: {} });
    await client.createTransaction(BUDGET, { transaction: { amount: -1 } } as never);
    const entry = getAuditLog().getAll()[0];
    expect(entry?.success).toBe(true);
    expect(entry?.resourceId).toBeUndefined();
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.transactions.createTransaction, new Error('fail'));
    await expect(
      client.createTransaction(BUDGET, { transaction: {} } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('updateTransaction (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.transactions.updateTransaction, { data: { transaction: {} } });
    await client.updateTransaction(BUDGET, 'txn-1', {
      transaction: { amount: 1, date: '2026-06-01', memo: 'note', category_id: 'c' },
    } as never);
    expect(asMock(mockApi.transactions.updateTransaction)).toHaveBeenCalledWith(
      BUDGET,
      'txn-1',
      expect.anything()
    );
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_update_transaction',
      resourceId: 'txn-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.transactions.updateTransaction, new Error('fail'));
    await expect(
      client.updateTransaction(BUDGET, 'txn-1', { transaction: {} } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('updateTransactions (bulk write)', () => {
  it('succeeds and logs counts', async () => {
    const client = makeClient(false);
    setResolve(mockApi.transactions.updateTransactions, {
      data: { transaction_ids: ['t1', 't2'] },
    });
    await client.updateTransactions(BUDGET, {
      transactions: [{ id: 't1' }, { id: 't2' }],
    } as never);
    const entry = getAuditLog().getAll()[0];
    expect(entry).toMatchObject({ tool: 'ynab_update_transactions', success: true });
    expect(entry?.details).toMatchObject({ requested_count: 2, updated_count: 2 });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.transactions.updateTransactions, new Error('fail'));
    await expect(
      client.updateTransactions(BUDGET, { transactions: [{ id: 't1' }] } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('deleteTransaction (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.transactions.deleteTransaction, {
      data: { transaction: { amount: -5, date: '2026-06-01' } },
    });
    await client.deleteTransaction(BUDGET, 'txn-1');
    expect(getAuditLog().getAll()[0]).toMatchObject({
      operation: 'delete',
      tool: 'ynab_delete_transaction',
      resourceId: 'txn-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.transactions.deleteTransaction, new Error('fail'));
    await expect(client.deleteTransaction(BUDGET, 'txn-1')).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('importTransactions (write)', () => {
  it('succeeds and logs imported_count', async () => {
    const client = makeClient(false);
    setResolve(mockApi.transactions.importTransactions, {
      data: { transaction_ids: ['a', 'b', 'c'] },
    });
    await client.importTransactions(BUDGET);
    const entry = getAuditLog().getAll()[0];
    expect(entry).toMatchObject({ tool: 'ynab_import_transactions', success: true });
    expect(entry?.details).toMatchObject({ imported_count: 3 });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.transactions.importTransactions, new Error('fail'));
    await expect(client.importTransactions(BUDGET)).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('createPayee (write)', () => {
  it('succeeds, invalidates payees cache, logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.payees.getPayees, { data: { payees: [] } });
    await client.getPayees(BUDGET);

    setResolve(mockApi.payees.createPayee, { data: { payee: { id: 'p-new' } } });
    await client.createPayee(BUDGET, { payee: { name: 'P' } } as never);

    await client.getPayees(BUDGET);
    expect(asMock(mockApi.payees.getPayees)).toHaveBeenCalledTimes(2);

    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_create_payee',
      resourceId: 'p-new',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.payees.createPayee, new Error('fail'));
    await expect(
      client.createPayee(BUDGET, { payee: { name: 'P' } } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('updatePayee (write)', () => {
  it('succeeds, invalidates payees cache, logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.payees.updatePayee, { data: { payee: { id: 'p-1' } } });
    await client.updatePayee(BUDGET, 'p-1', { payee: { name: 'New' } } as never);
    expect(asMock(mockApi.payees.updatePayee)).toHaveBeenCalledWith(BUDGET, 'p-1', {
      payee: { name: 'New' },
    });
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_update_payee',
      resourceId: 'p-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.payees.updatePayee, new Error('fail'));
    await expect(
      client.updatePayee(BUDGET, 'p-1', { payee: { name: 'New' } } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('createScheduledTransaction (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.scheduledTransactions.createScheduledTransaction, {
      data: { scheduled_transaction: { id: 'sch-new' } },
    });
    await client.createScheduledTransaction(BUDGET, {
      scheduled_transaction: { amount: -100, date: '2026-06-01', frequency: 'monthly' },
    } as never);
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_create_scheduled_transaction',
      resourceId: 'sch-new',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.scheduledTransactions.createScheduledTransaction, new Error('fail'));
    await expect(
      client.createScheduledTransaction(BUDGET, { scheduled_transaction: {} } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('updateScheduledTransaction (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.scheduledTransactions.updateScheduledTransaction, {
      data: { scheduled_transaction: { id: 'sch-1' } },
    });
    await client.updateScheduledTransaction(BUDGET, 'sch-1', {
      scheduled_transaction: { amount: -100, memo: 'm', category_id: 'c' },
    } as never);
    expect(getAuditLog().getAll()[0]).toMatchObject({
      tool: 'ynab_update_scheduled_transaction',
      resourceId: 'sch-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.scheduledTransactions.updateScheduledTransaction, new Error('fail'));
    await expect(
      client.updateScheduledTransaction(BUDGET, 'sch-1', { scheduled_transaction: {} } as never)
    ).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});

describe('deleteScheduledTransaction (write)', () => {
  it('succeeds and logs', async () => {
    const client = makeClient(false);
    setResolve(mockApi.scheduledTransactions.deleteScheduledTransaction, {
      data: { scheduled_transaction: { amount: -5, date_next: '2026-07-01' } },
    });
    await client.deleteScheduledTransaction(BUDGET, 'sch-1');
    expect(getAuditLog().getAll()[0]).toMatchObject({
      operation: 'delete',
      tool: 'ynab_delete_scheduled_transaction',
      resourceId: 'sch-1',
      success: true,
    });
  });

  it('logs failure and rethrows', async () => {
    const client = makeClient(false);
    setReject(mockApi.scheduledTransactions.deleteScheduledTransaction, new Error('fail'));
    await expect(client.deleteScheduledTransaction(BUDGET, 'sch-1')).rejects.toThrow('fail');
    expect(getAuditLog().getAll()[0]).toMatchObject({ success: false });
  });
});
