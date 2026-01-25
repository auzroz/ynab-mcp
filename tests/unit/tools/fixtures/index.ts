/**
 * Test Fixtures Index
 *
 * Central export for all mock data fixtures.
 */

// Mock client factory
export { createMockClient, type MockClient } from './mock-client.js';

// Account fixtures
export {
  mockCheckingAccount,
  mockSavingsAccount,
  mockCreditCardAccount,
  mockCreditCardWithOverpayment,
  mockMortgageAccount,
  mockInvestmentAccount,
  mockClosedAccount,
  mockAutoLoanAccount,
  mockBudgetAccounts,
  mockTrackingAccounts,
  mockAllAccounts,
  createAccountsResponse,
  createAccountResponse,
} from './mock-accounts.js';

// Category fixtures
export {
  mockBillsCategories,
  mockEverydayCategories,
  mockSavingsCategories,
  mockDiscretionaryCategories,
  mockHiddenCategory,
  mockCreditCardPaymentCategory,
  mockReadyToAssignCategory,
  mockCategoryGroups,
  mockAllCategories,
  createCategoriesResponse,
  createCategoryResponse,
  healthyBudgetCategories,
  overspentBudgetCategories,
} from './mock-categories.js';

// Transaction fixtures
export {
  mockGroceryTransactions,
  mockDiningTransactions,
  mockSubscriptionTransactions,
  mockBillTransactions,
  mockIncomeTransactions,
  mockTransferTransaction,
  mockCreditCardPaymentTransaction,
  mockSplitTransaction,
  mockUnclearedTransaction,
  mockFlaggedTransaction,
  mockAllTransactions,
  mockScheduledTransactions,
  createTransactionsResponse,
  createTransactionResponse,
  createScheduledTransactionsResponse,
  createScheduledTransactionResponse,
  createMonthTransactions,
} from './mock-transactions.js';

// Budget fixtures
export {
  mockUsdCurrencyFormat,
  mockEurCurrencyFormat,
  mockGbpCurrencyFormat,
  mockJpyCurrencyFormat,
  mockBudgetSummary,
  mockEurBudgetSummary,
  mockBudgetDetail,
  mockMonthSummaries,
  mockMonthDetail,
  mockOverspentMonth,
  mockBudgetSettings,
  mockEurBudgetSettings,
  createBudgetsResponse,
  createBudgetResponse,
  createBudgetSettingsResponse,
  createMonthsResponse,
  createMonthResponse,
  createHealthyBudgetMonth,
  createUnderBudgetedMonth,
} from './mock-budgets.js';

// Payee fixtures
export {
  mockPayees,
  mockTransferPayees,
  mockDeletedPayee,
  mockAllPayees,
  mockPayeeLocations,
  createPayeesResponse,
  createPayeeResponse,
  createPayeeLocationsResponse,
  createPayeeLocationResponse,
  getPayeeById,
  getLocationsForPayee,
  mockSubscriptionPayees,
  mockDiningPayees,
  mockGroceryPayees,
} from './mock-payees.js';
