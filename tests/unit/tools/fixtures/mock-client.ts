import { vi } from 'vitest';

export function createMockClient() {
  return {
    resolveBudgetId: vi.fn((id?: string) => id ?? 'test-budget-id'),
    getDefaultBudgetId: vi.fn(() => 'test-budget-id'),
    isReadOnly: vi.fn(() => true),

    // Budget endpoints
    getBudgets: vi.fn(),
    getBudgetById: vi.fn(),
    getBudgetSettingsById: vi.fn(),

    // Account endpoints
    getAccounts: vi.fn(),
    getAccountById: vi.fn(),
    createAccount: vi.fn(),

    // Category endpoints
    getCategories: vi.fn(),
    getCategoryById: vi.fn(),
    getMonthCategoryById: vi.fn(),
    updateMonthCategory: vi.fn(),

    // Transaction endpoints
    getTransactions: vi.fn(),
    getTransactionById: vi.fn(),
    createTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    getAccountTransactions: vi.fn(),
    getCategoryTransactions: vi.fn(),
    getPayeeTransactions: vi.fn(),

    // Scheduled transaction endpoints
    getScheduledTransactions: vi.fn(),
    getScheduledTransactionById: vi.fn(),

    // Payee endpoints
    getPayees: vi.fn(),
    getPayeeById: vi.fn(),
    getPayeeLocations: vi.fn(),
    getPayeeLocationById: vi.fn(),

    // Month endpoints
    getBudgetMonths: vi.fn(),
    getBudgetMonth: vi.fn(),

    // Import
    importTransactions: vi.fn(),
  };
}

export type MockClient = ReturnType<typeof createMockClient>;
