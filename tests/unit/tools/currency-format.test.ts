/**
 * Amounts follow the budget's currency_format (#49).
 *
 * Every tool formats its human-readable amounts through the budget's cached
 * format. These tests run representative tools against EUR, JPY and BHD
 * formats and the USD fallback, and check that only strings change: raw
 * milliunit fields and the shape of the output stay as they were.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CurrencyFormat } from 'ynab';
import { handleListAccounts } from '../../../src/tools/accounts/list-accounts.js';
import { handleGetAccount } from '../../../src/tools/accounts/get-account.js';
import { handleListCategories } from '../../../src/tools/categories/list-categories.js';
import { handleGetCategory } from '../../../src/tools/categories/get-category.js';
import { handleListTransactions } from '../../../src/tools/transactions/list-transactions.js';
import { handleQuickSummary } from '../../../src/tools/analytics/quick-summary.js';
import { handleTransactionSearch } from '../../../src/tools/analytics/transaction-search.js';
import { handleGetBudget } from '../../../src/tools/budgets/get-budget.js';
import { handleListBudgets } from '../../../src/tools/budgets/list-budgets.js';
import {
  createMockClient,
  createAccountsResponse,
  createAccountResponse,
  createCategoriesResponse,
  createCategoryResponse,
  createTransactionsResponse,
  createMonthResponse,
  createBudgetResponse,
  createBudgetsResponse,
  mockAllAccounts,
  mockCheckingAccount,
  mockSavingsCategories,
  mockCategoryGroups,
  mockAllTransactions,
  mockSplitTransaction,
  mockMonthDetail,
  mockBudgetDetail,
  mockBudgetSummary,
  mockEurCurrencyFormat,
  mockJpyCurrencyFormat,
  mockUsdCurrencyFormat,
} from './fixtures/index.js';
import type { MockClient } from './fixtures/index.js';

const bhd: CurrencyFormat = {
  iso_code: 'BHD',
  example_format: 'BD123,456.789',
  decimal_digits: 3,
  decimal_separator: '.',
  symbol_first: true,
  group_separator: ',',
  currency_symbol: 'BD',
  display_symbol: true,
};

const eurNoSymbol: CurrencyFormat = { ...mockEurCurrencyFormat, display_symbol: false };

/** The output with every string removed: keys, numbers, booleans and nulls only. */
function skeleton(value: unknown): unknown {
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) return value.map(skeleton);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, skeleton(v)]));
  }
  return value;
}

/** Every string in the output that mentions a currency amount. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe('amounts follow the budget currency format', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    client.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    client.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));
    client.getTransactions.mockResolvedValue(createTransactionsResponse(mockAllTransactions));
  });

  it('asks for the format of the resolved budget, once per call', async () => {
    client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
    await handleListAccounts({ budget_id: 'budget-uuid' }, client as never);
    expect(client.getCurrencyFormat).toHaveBeenCalledTimes(1);
    expect(client.getCurrencyFormat).toHaveBeenCalledWith('budget-uuid');
  });

  describe('ynab_list_accounts', () => {
    it('formats balances in EUR: symbol after, comma decimals, dot groups', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      const parsed = await handleListAccounts({}, client as never);
      const checking = parsed.accounts_by_type.checking[0];

      expect(checking.balance).toMatch(/^-?\d{1,3}(\.\d{3})*,\d{2}€$/);
      expect(parsed.summary.net_worth).toMatch(/€$/);
      expect(strings(parsed).some((s) => s.includes('$'))).toBe(false);
    });

    it('formats balances in JPY with no decimal places', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockJpyCurrencyFormat);
      const parsed = await handleListAccounts({}, client as never);

      expect(parsed.accounts_by_type.checking[0].balance).toMatch(/^-?¥\d{1,3}(,\d{3})*$/);
      expect(parsed.summary.total_assets).toMatch(/^¥[\d,]+$/);
    });

    it('formats balances with three decimal places (BHD)', async () => {
      client.getCurrencyFormat.mockResolvedValue(bhd);
      const parsed = await handleListAccounts({}, client as never);
      expect(parsed.accounts_by_type.checking[0].balance).toMatch(/^-?BD\d{1,3}(,\d{3})*\.\d{3}$/);
    });

    it('drops the symbol when display_symbol is false', async () => {
      client.getCurrencyFormat.mockResolvedValue(eurNoSymbol);
      const parsed = await handleListAccounts({}, client as never);
      expect(parsed.accounts_by_type.checking[0].balance).toMatch(/^-?\d{1,3}(\.\d{3})*,\d{2}$/);
    });

    it('keeps raw fields and the output shape: only strings change', async () => {
      client.getCurrencyFormat.mockResolvedValue(undefined);
      const fallback = await handleListAccounts({}, client as never);
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      const eur = await handleListAccounts({}, client as never);

      expect(skeleton(eur)).toEqual(skeleton(fallback));
      expect(eur).not.toEqual(fallback);
    });
  });

  describe('fallback when the settings cannot be read', () => {
    it('formats in the USD style when the client has no format', async () => {
      client.getCurrencyFormat.mockResolvedValue(undefined);
      const parsed = await handleListAccounts({}, client as never);
      expect(parsed.accounts_by_type.checking[0].balance).toMatch(/^-?\$\d+\.\d{2}$/);
    });

    it('formats in the USD style when the lookup throws', async () => {
      client.getCurrencyFormat.mockRejectedValue(new Error('settings unavailable'));
      const parsed = await handleListAccounts({}, client as never);
      expect(parsed.accounts_by_type.checking[0].balance).toMatch(/^-?\$\d+\.\d{2}$/);
    });

    it('formats in the USD style for a malformed format', async () => {
      client.getCurrencyFormat.mockResolvedValue({ currency_symbol: '€' } as never);
      const parsed = await handleListAccounts({}, client as never);
      expect(parsed.accounts_by_type.checking[0].balance).toMatch(/^-?\$\d+\.\d{2}$/);
    });
  });

  describe('a real USD format', () => {
    it('adds group separators (the fallback has none)', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockUsdCurrencyFormat);
      client.getAccountById.mockResolvedValue(
        createAccountResponse({ ...mockCheckingAccount, balance: 3_000_000 })
      );
      const parsed = await handleGetAccount({ account_id: mockCheckingAccount.id }, client as never);
      expect(parsed.account.balance).toBe('$3,000.00');
    });
  });

  describe('ynab_get_account', () => {
    it('formats debt fields and per-month maps', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      client.getAccountById.mockResolvedValue(
        createAccountResponse({
          ...mockCheckingAccount,
          debt_original_balance: -1_500_000,
          debt_minimum_payments: { '2024-01-01': 25_500 },
          debt_escrow_amounts: { '2024-01-01': 1_234_000 },
          debt_interest_rates: { '2024-01-01': 18_990 },
        } as never)
      );
      const parsed = await handleGetAccount({ account_id: mockCheckingAccount.id }, client as never);

      expect(parsed.account.debt_original_balance).toBe('-1.500,00€');
      expect(parsed.account.debt_minimum_payments_formatted['2024-01-01']).toBe('25,50€');
      expect(parsed.account.debt_escrow_amounts_formatted['2024-01-01']).toBe('1.234,00€');
      // Raw maps and rates are untouched.
      expect(parsed.account.debt_minimum_payments).toEqual({ '2024-01-01': 25_500 });
      expect(parsed.account.debt_interest_rates_formatted['2024-01-01']).toBe('18.99%');
    });
  });

  describe('ynab_list_categories and ynab_get_category', () => {
    it('formats category amounts, totals and goal amounts', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      const parsed = await handleListCategories({}, client as never);
      const cat = parsed.category_groups.flatMap((g: { categories: unknown[] }) => g.categories)[0];

      expect(cat.budgeted).toMatch(/€$/);
      expect(parsed.summary.total_budgeted).toMatch(/€$/);
      expect(typeof cat.balance_raw).toBe('number');
      expect(strings(parsed).some((s) => /^-?\$\d/.test(s))).toBe(false);
    });

    it('formats the decoded goal with the same format', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockJpyCurrencyFormat);
      client.getCategoryById.mockResolvedValue(createCategoryResponse(mockSavingsCategories[1]));
      const parsed = await handleGetCategory({ category_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }, client as never);

      expect(parsed.category.goal.target).toBe('¥3,000');
      expect(parsed.category.goal.under_funded).toBe('¥300');
      expect(parsed.category.balance).toMatch(/^-?¥/);
    });

    it('formats delta responses too', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      client.getCategories.mockResolvedValue({
        data: { category_groups: mockCategoryGroups, server_knowledge: 9 },
      } as never);
      const parsed = await handleListCategories({ since_server_knowledge: 1 }, client as never);
      const cats = parsed.category_groups.flatMap((g: { categories: { budgeted: string }[] }) => g.categories);
      expect(cats.length).toBeGreaterThan(0);
      for (const c of cats) expect(c.budgeted).toMatch(/€$/);
    });
  });

  describe('ynab_list_transactions', () => {
    it('formats amounts and split lines', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      client.getTransactions.mockResolvedValue(createTransactionsResponse([mockSplitTransaction]));
      const parsed = JSON.parse(await handleListTransactions({}, client as never));
      const txn = parsed.transactions[0];

      expect(txn.amount).toBe('-150,00€');
      expect(txn.subtransactions[0].amount).toBe('-100,00€');
      expect(parsed.summary.total_inflow).toBe('0,00€');
      expect(parsed.summary.total_outflow).toBe('150,00€');
      expect(parsed.summary.net).toBe('-150,00€');
    });
  });

  describe('analytics', () => {
    it('ynab_quick_summary formats metrics in the budget currency', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockJpyCurrencyFormat);
      client.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
      const parsed = JSON.parse(await handleQuickSummary({}, client as never));

      expect(parsed.key_metrics.ready_to_assign).toMatch(/^-?¥[\d,]+$/);
      expect(parsed.key_metrics.spent_this_month).toMatch(/^-?¥[\d,]+$/);
      expect(parsed.key_metrics.age_of_money).toBe('45 days');
    });

    it('ynab_transaction_search describes min and max in the budget currency', async () => {
      client.getCurrencyFormat.mockResolvedValue(mockEurCurrencyFormat);
      const parsed = JSON.parse(
        await handleTransactionSearch({ min_amount: 80, max_amount: 100 }, client as never)
      );
      const criteria = JSON.stringify(parsed);
      expect(criteria).toContain('min: 80,00€');
      expect(criteria).toContain('max: 100,00€');
    });
  });

  describe('budgets', () => {
    it('ynab_get_budget uses the currency format the budget response carries, with no settings request', async () => {
      client.getBudgetById.mockResolvedValue(
        createBudgetResponse({ ...mockBudgetDetail, currency_format: mockEurCurrencyFormat })
      );
      const parsed = await handleGetBudget({}, client as never);
      expect(strings(parsed).some((s) => /€$/.test(s))).toBe(true);
      expect(client.getCurrencyFormat).not.toHaveBeenCalled();
    });

    it('ynab_list_budgets formats account balances with each budget own format', async () => {
      client.getBudgets.mockResolvedValue(
        createBudgetsResponse([
          {
            ...mockBudgetSummary,
            currency_format: mockJpyCurrencyFormat,
            accounts: [{ ...mockCheckingAccount, balance: 1_234_000 }],
          } as never,
        ])
      );
      const parsed = await handleListBudgets({ include_accounts: true }, client as never);
      expect(parsed.budgets[0].accounts[0].balance).toBe('¥1,234');
      expect(client.getCurrencyFormat).not.toHaveBeenCalled();
    });
  });
});

