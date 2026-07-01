import { vi } from 'vitest';

/**
 * Default rate-limiter status used by system/health-check tools.
 * Tests can override via mockClient.getRateLimitStatus.mockReturnValue(...).
 */
const defaultRateLimitStatus = {
  available: 180,
  limit: 180,
  used: 0,
  percentUsed: 0,
  canMakeRequest: true,
  waitTimeMs: 0,
  resetTimeMs: 0,
};

export function createMockClient() {
  return {
    resolveBudgetId: vi.fn((id?: string) => id ?? 'test-budget-id'),
    getDefaultBudgetId: vi.fn(() => 'test-budget-id'),
    isReadOnly: vi.fn(() => true),
    getRateLimitStatus: vi.fn(() => ({ ...defaultRateLimitStatus })),
    getServerKnowledge: vi.fn((): number | undefined => undefined),
    updateServerKnowledge: vi.fn(),

    // User
    getUser: vi.fn(),

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
    createCategory: vi.fn(),
    createCategoryGroup: vi.fn(),
    updateCategoryGroup: vi.fn(),

    // Transaction endpoints
    getTransactions: vi.fn(),
    getTransactionById: vi.fn(),
    createTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    updateTransactions: vi.fn(),
    deleteTransaction: vi.fn(),
    getAccountTransactions: vi.fn(),
    getCategoryTransactions: vi.fn(),
    getPayeeTransactions: vi.fn(),
    importTransactions: vi.fn(),

    // Scheduled transaction endpoints
    getScheduledTransactions: vi.fn(),
    getScheduledTransactionById: vi.fn(),
    createScheduledTransaction: vi.fn(),
    updateScheduledTransaction: vi.fn(),
    deleteScheduledTransaction: vi.fn(),

    // Payee endpoints
    getPayees: vi.fn(),
    getPayeeById: vi.fn(),
    createPayee: vi.fn(),
    updatePayee: vi.fn(),
    getPayeeLocations: vi.fn(),
    getPayeeLocationById: vi.fn(),
    getPayeeLocationsByPayee: vi.fn(),

    // Month endpoints
    getBudgetMonths: vi.fn(),
    getBudgetMonth: vi.fn(),

    // Money movements
    getMoneyMovements: vi.fn(),
  };
}

export type MockClient = ReturnType<typeof createMockClient>;
