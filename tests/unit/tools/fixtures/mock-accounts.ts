/**
 * Mock Account Fixtures
 *
 * Realistic YNAB account data for testing.
 */

import type { Account } from 'ynab';

// Use type assertion to allow string literal types
type MockAccount = Omit<Account, 'type'> & { type: string };

export const mockCheckingAccount: MockAccount = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Primary Checking',
  type: 'checking',
  on_budget: true,
  closed: false,
  note: 'Main checking account',
  balance: 2500000, // $2,500.00
  cleared_balance: 2400000, // $2,400.00
  uncleared_balance: 100000, // $100.00
  transfer_payee_id: 'tp-checking-111',
  direct_import_linked: true,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-15T12:00:00Z',
  debt_original_balance: null,
  debt_interest_rates: {},
  debt_minimum_payments: {},
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockSavingsAccount: MockAccount = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Emergency Fund',
  type: 'savings',
  on_budget: true,
  closed: false,
  note: 'Emergency savings',
  balance: 10000000, // $10,000.00
  cleared_balance: 10000000,
  uncleared_balance: 0,
  transfer_payee_id: 'tp-savings-222',
  direct_import_linked: true,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-10T12:00:00Z',
  debt_original_balance: null,
  debt_interest_rates: {},
  debt_minimum_payments: {},
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockCreditCardAccount: MockAccount = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Chase Visa',
  type: 'creditCard',
  on_budget: true,
  closed: false,
  note: 'Primary credit card',
  balance: -1500000, // -$1,500.00 (owed)
  cleared_balance: -1450000,
  uncleared_balance: -50000,
  transfer_payee_id: 'tp-cc-333',
  direct_import_linked: true,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-14T12:00:00Z',
  debt_original_balance: null,
  debt_interest_rates: {},
  debt_minimum_payments: {},
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockCreditCardWithOverpayment: MockAccount = {
  id: '33333333-3333-3333-3333-333333333334',
  name: 'Amex Gold',
  type: 'creditCard',
  on_budget: true,
  closed: false,
  note: 'Has credit balance from overpayment',
  balance: 50000, // $50.00 credit (overpaid)
  cleared_balance: 50000,
  uncleared_balance: 0,
  transfer_payee_id: 'tp-cc-amex',
  direct_import_linked: true,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-12T12:00:00Z',
  debt_original_balance: null,
  debt_interest_rates: {},
  debt_minimum_payments: {},
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockMortgageAccount: MockAccount = {
  id: '44444444-4444-4444-4444-444444444444',
  name: 'Home Mortgage',
  type: 'mortgage',
  on_budget: false,
  closed: false,
  note: '30-year fixed',
  balance: -250000000, // -$250,000.00
  cleared_balance: -250000000,
  uncleared_balance: 0,
  transfer_payee_id: 'tp-mortgage-444',
  direct_import_linked: false,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-01T12:00:00Z',
  debt_original_balance: -300000000, // -$300,000.00 original
  debt_interest_rates: { '44444444-4444-4444-4444-444444444444': 4500 }, // 4.5%
  debt_minimum_payments: { '44444444-4444-4444-4444-444444444444': 1500000 }, // $1,500/month
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockInvestmentAccount: MockAccount = {
  id: '55555555-5555-5555-5555-555555555555',
  name: '401k',
  type: 'otherAsset',
  on_budget: false,
  closed: false,
  note: 'Retirement account',
  balance: 75000000, // $75,000.00
  cleared_balance: 75000000,
  uncleared_balance: 0,
  transfer_payee_id: 'tp-401k-555',
  direct_import_linked: false,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-01T12:00:00Z',
  debt_original_balance: null,
  debt_interest_rates: {},
  debt_minimum_payments: {},
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockClosedAccount: MockAccount = {
  id: '66666666-6666-6666-6666-666666666666',
  name: 'Old Savings',
  type: 'savings',
  on_budget: true,
  closed: true,
  note: 'Closed account',
  balance: 0,
  cleared_balance: 0,
  uncleared_balance: 0,
  transfer_payee_id: 'tp-old-666',
  direct_import_linked: false,
  direct_import_in_error: false,
  last_reconciled_at: '2023-06-01T12:00:00Z',
  debt_original_balance: null,
  debt_interest_rates: {},
  debt_minimum_payments: {},
  debt_escrow_amounts: {},
  deleted: false,
};

export const mockAutoLoanAccount: MockAccount = {
  id: '77777777-7777-7777-7777-777777777777',
  name: 'Car Loan',
  type: 'autoLoan',
  on_budget: false,
  closed: false,
  note: 'Auto loan',
  balance: -15000000, // -$15,000.00
  cleared_balance: -15000000,
  uncleared_balance: 0,
  transfer_payee_id: 'tp-auto-777',
  direct_import_linked: false,
  direct_import_in_error: false,
  last_reconciled_at: '2024-01-01T12:00:00Z',
  debt_original_balance: -25000000, // -$25,000.00 original
  debt_interest_rates: { '77777777-7777-7777-7777-777777777777': 5900 }, // 5.9%
  debt_minimum_payments: { '77777777-7777-7777-7777-777777777777': 450000 }, // $450/month
  debt_escrow_amounts: {},
  deleted: false,
};

// Preset collections for different test scenarios
export const mockBudgetAccounts: MockAccount[] = [
  mockCheckingAccount,
  mockSavingsAccount,
  mockCreditCardAccount,
  mockCreditCardWithOverpayment,
];

export const mockTrackingAccounts: MockAccount[] = [
  mockMortgageAccount,
  mockInvestmentAccount,
  mockAutoLoanAccount,
];

export const mockAllAccounts: MockAccount[] = [
  ...mockBudgetAccounts,
  ...mockTrackingAccounts,
  mockClosedAccount,
];

// Account response factory
export function createAccountsResponse(accounts: MockAccount[] = mockAllAccounts) {
  return {
    data: {
      accounts: accounts as unknown as Account[],
      server_knowledge: 12345,
    },
  };
}

export function createAccountResponse(account: MockAccount = mockCheckingAccount) {
  return {
    data: {
      account: account as unknown as Account,
    },
  };
}
