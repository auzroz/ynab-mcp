/**
 * Mock Budget Fixtures
 *
 * Realistic YNAB budget and month data for testing.
 */

import type { BudgetSummary, BudgetDetail, MonthSummary, MonthDetail, CurrencyFormat } from 'ynab';
import { mockCategoryGroups } from './mock-categories.js';
import { mockAllAccounts } from './mock-accounts.js';

// USD currency format (default)
export const mockUsdCurrencyFormat: CurrencyFormat = {
  iso_code: 'USD',
  example_format: '$1,234.56',
  decimal_digits: 2,
  decimal_separator: '.',
  symbol_first: true,
  group_separator: ',',
  currency_symbol: '$',
  display_symbol: true,
};

// EUR currency format
export const mockEurCurrencyFormat: CurrencyFormat = {
  iso_code: 'EUR',
  example_format: '1.234,56 €',
  decimal_digits: 2,
  decimal_separator: ',',
  symbol_first: false,
  group_separator: '.',
  currency_symbol: '€',
  display_symbol: true,
};

// GBP currency format
export const mockGbpCurrencyFormat: CurrencyFormat = {
  iso_code: 'GBP',
  example_format: '£1,234.56',
  decimal_digits: 2,
  decimal_separator: '.',
  symbol_first: true,
  group_separator: ',',
  currency_symbol: '£',
  display_symbol: true,
};

// JPY currency format (no decimals)
export const mockJpyCurrencyFormat: CurrencyFormat = {
  iso_code: 'JPY',
  example_format: '¥1,234',
  decimal_digits: 0,
  decimal_separator: '.',
  symbol_first: true,
  group_separator: ',',
  currency_symbol: '¥',
  display_symbol: true,
};

// Budget summary
export const mockBudgetSummary: BudgetSummary = {
  id: 'budget-11111111-1111-1111-1111-111111111111',
  name: 'My Budget',
  last_modified_on: '2024-01-30T12:00:00Z',
  first_month: '2023-01-01',
  last_month: '2024-12-01',
  date_format: {
    format: 'MM/DD/YYYY',
  },
  currency_format: mockUsdCurrencyFormat,
  accounts: mockAllAccounts as unknown as BudgetSummary['accounts'],
};

// Secondary budget (EUR)
export const mockEurBudgetSummary: BudgetSummary = {
  id: 'budget-22222222-2222-2222-2222-222222222222',
  name: 'European Budget',
  last_modified_on: '2024-01-28T12:00:00Z',
  first_month: '2023-06-01',
  last_month: '2024-12-01',
  date_format: {
    format: 'DD/MM/YYYY',
  },
  currency_format: mockEurCurrencyFormat,
  accounts: [],
};

// Budget detail
export const mockBudgetDetail: BudgetDetail = {
  id: 'budget-11111111-1111-1111-1111-111111111111',
  name: 'My Budget',
  last_modified_on: '2024-01-30T12:00:00Z',
  first_month: '2023-01-01',
  last_month: '2024-12-01',
  date_format: {
    format: 'MM/DD/YYYY',
  },
  currency_format: mockUsdCurrencyFormat,
  accounts: mockAllAccounts as unknown as BudgetDetail['accounts'],
  payees: [],
  payee_locations: [],
  category_groups: mockCategoryGroups,
  categories: [],
  months: [],
  transactions: [],
  subtransactions: [],
  scheduled_transactions: [],
  scheduled_subtransactions: [],
};

// Month summary (for list months)
export const mockMonthSummaries: MonthSummary[] = [
  {
    month: '2024-01-01',
    note: 'January budget',
    income: 5000000, // $5,000
    budgeted: 4500000, // $4,500
    activity: -3200000, // -$3,200
    to_be_budgeted: 500000, // $500
    age_of_money: 45,
    deleted: false,
  },
  {
    month: '2023-12-01',
    note: 'December budget',
    income: 5000000,
    budgeted: 4800000,
    activity: -4500000,
    to_be_budgeted: 0,
    age_of_money: 42,
    deleted: false,
  },
  {
    month: '2023-11-01',
    note: 'November budget',
    income: 5000000,
    budgeted: 4600000,
    activity: -4200000,
    to_be_budgeted: 0,
    age_of_money: 40,
    deleted: false,
  },
  {
    month: '2023-10-01',
    note: null,
    income: 5000000,
    budgeted: 4700000,
    activity: -4100000,
    to_be_budgeted: 0,
    age_of_money: 38,
    deleted: false,
  },
];

// Month detail (for get month)
export const mockMonthDetail: MonthDetail = {
  month: '2024-01-01',
  note: 'January budget',
  income: 5000000,
  budgeted: 4500000,
  activity: -3200000,
  to_be_budgeted: 500000,
  age_of_money: 45,
  deleted: false,
  categories: mockCategoryGroups.flatMap((g) => g.categories),
};

// Overspent month
export const mockOverspentMonth: MonthDetail = {
  month: '2024-01-01',
  note: 'Overspent month',
  income: 5000000,
  budgeted: 5500000, // Budgeted more than income
  activity: -4800000,
  to_be_budgeted: -500000, // Negative to_be_budgeted
  age_of_money: 30,
  deleted: false,
  categories: mockCategoryGroups.flatMap((g) => g.categories),
};

// Budget settings
export const mockBudgetSettings = {
  settings: {
    date_format: {
      format: 'MM/DD/YYYY',
    },
    currency_format: mockUsdCurrencyFormat,
  },
};

export const mockEurBudgetSettings = {
  settings: {
    date_format: {
      format: 'DD/MM/YYYY',
    },
    currency_format: mockEurCurrencyFormat,
  },
};

// Response factories
export function createBudgetsResponse(budgets: BudgetSummary[] = [mockBudgetSummary, mockEurBudgetSummary]) {
  return {
    data: {
      budgets,
      default_budget: budgets[0] ?? null,
    },
  };
}

export function createBudgetResponse(budget: BudgetDetail = mockBudgetDetail) {
  return {
    data: {
      budget,
      server_knowledge: 12345,
    },
  };
}

export function createBudgetSettingsResponse(currencyFormat: CurrencyFormat = mockUsdCurrencyFormat) {
  return {
    data: {
      settings: {
        date_format: {
          format: currencyFormat.iso_code === 'USD' ? 'MM/DD/YYYY' : 'DD/MM/YYYY',
        },
        currency_format: currencyFormat,
      },
    },
  };
}

export function createMonthsResponse(months: MonthSummary[] = mockMonthSummaries) {
  return {
    data: {
      months,
      server_knowledge: 12345,
    },
  };
}

export function createMonthResponse(month: MonthDetail = mockMonthDetail) {
  return {
    data: {
      month,
    },
  };
}

// Preset scenarios
export function createHealthyBudgetMonth(): MonthDetail {
  return {
    ...mockMonthDetail,
    to_be_budgeted: 0, // Fully allocated
    activity: -4000000, // Spent less than budgeted
  };
}

export function createUnderBudgetedMonth(): MonthDetail {
  return {
    ...mockMonthDetail,
    to_be_budgeted: 1000000, // $1,000 unallocated
  };
}
