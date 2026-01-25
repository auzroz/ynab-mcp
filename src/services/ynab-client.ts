/**
 * YNAB Client Wrapper
 *
 * Wraps the official YNAB SDK with rate limiting, caching, and read-only mode.
 */

import * as ynab from 'ynab';
import type { RateLimiter } from './rate-limiter.js';
import type { Cache } from './cache.js';
import { ReadOnlyModeError } from '../utils/errors.js';
import { getAuditLog } from './audit-log.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

export class YnabClient {
  private readonly api: ynab.API;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: Cache;
  private readonly defaultBudgetId: string;
  private readonly readOnly: boolean;

  // Track server knowledge for delta sync
  private serverKnowledge: Map<string, number> = new Map();

  constructor(
    accessToken: string,
    defaultBudgetId: string | undefined,
    rateLimiter: RateLimiter,
    cache: Cache,
    readOnly = true
  ) {
    this.api = new ynab.API(accessToken);
    this.rateLimiter = rateLimiter;
    this.cache = cache;
    this.defaultBudgetId = defaultBudgetId ?? 'last-used';
    this.readOnly = readOnly;
  }

  /**
   * Check if the client is in read-only mode.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Get rate limit status.
   */
  getRateLimitStatus(): ReturnType<RateLimiter['getStatus']> {
    return this.rateLimiter.getStatus();
  }

  /**
   * Guard against write operations in read-only mode.
   * @throws ReadOnlyModeError if in read-only mode
   */
  private assertWriteAllowed(operation: string): void {
    if (this.readOnly) {
      throw new ReadOnlyModeError(operation);
    }
  }

  /**
   * Get the default budget ID, resolving "last-used" if needed.
   */
  getDefaultBudgetId(): string {
    return this.defaultBudgetId;
  }

  /**
   * Resolve a budget ID, using default if not provided.
   */
  resolveBudgetId(budgetId?: string): string {
    return budgetId ?? this.defaultBudgetId;
  }

  /**
   * Get server knowledge for a budget (used for delta sync).
   */
  getServerKnowledge(budgetId: string): number | undefined {
    return this.serverKnowledge.get(budgetId);
  }

  /**
   * Update server knowledge after a response.
   */
  updateServerKnowledge(budgetId: string, knowledge: number): void {
    this.serverKnowledge.set(budgetId, knowledge);
  }

  // ==================== User ====================

  async getUser(): Promise<ynab.UserResponse> {
    await this.rateLimiter.acquire();
    return this.api.user.getUser();
  }

  // ==================== Budgets ====================

  async getBudgets(includeAccounts = false): Promise<ynab.BudgetSummaryResponse> {
    const cacheKey = `budgets:${includeAccounts}`;
    const cached = this.cache.get<ynab.BudgetSummaryResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.budgets.getBudgets(includeAccounts);
    this.cache.set(cacheKey, response);
    return response;
  }

  async getBudgetById(
    budgetId: string,
    lastKnowledgeOfServer?: number
  ): Promise<ynab.BudgetDetailResponse> {
    await this.rateLimiter.acquire();
    const response = await this.api.budgets.getBudgetById(budgetId, lastKnowledgeOfServer);
    
    if (response.data.server_knowledge !== undefined) {
      this.updateServerKnowledge(budgetId, response.data.server_knowledge);
    }
    
    return response;
  }

  async getBudgetSettingsById(budgetId: string): Promise<ynab.BudgetSettingsResponse> {
    const cacheKey = `budget-settings:${budgetId}`;
    const cached = this.cache.get<ynab.BudgetSettingsResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.budgets.getBudgetSettingsById(budgetId);
    this.cache.set(cacheKey, response);
    return response;
  }

  // ==================== Accounts ====================

  async getAccounts(budgetId: string): Promise<ynab.AccountsResponse> {
    const cacheKey = `accounts:${budgetId}`;
    const cached = this.cache.get<ynab.AccountsResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.accounts.getAccounts(budgetId);
    this.cache.set(cacheKey, response);
    return response;
  }

  async getAccountById(budgetId: string, accountId: string): Promise<ynab.AccountResponse> {
    await this.rateLimiter.acquire();
    return this.api.accounts.getAccountById(budgetId, accountId);
  }

  async createAccount(
    budgetId: string,
    data: ynab.PostAccountWrapper
  ): Promise<ynab.AccountResponse> {
    this.assertWriteAllowed('createAccount');
    await this.rateLimiter.acquire();
    // Invalidate accounts cache after creating
    this.cache.delete(`accounts:${budgetId}`);

    const auditLog = getAuditLog();
    try {
      const response = await this.api.accounts.createAccount(budgetId, data);
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_account',
        budgetId,
        resourceType: 'account',
        resourceId: response.data.account.id,
        details: { type: data.account.type, has_name: !!data.account.name },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_account',
        budgetId,
        resourceType: 'account',
        details: { type: data.account.type, has_name: !!data.account.name },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  // ==================== Categories ====================

  async getCategories(budgetId: string): Promise<ynab.CategoriesResponse> {
    const cacheKey = `categories:${budgetId}`;
    const cached = this.cache.get<ynab.CategoriesResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.categories.getCategories(budgetId);
    this.cache.set(cacheKey, response);
    return response;
  }

  async getCategoryById(budgetId: string, categoryId: string): Promise<ynab.CategoryResponse> {
    await this.rateLimiter.acquire();
    return this.api.categories.getCategoryById(budgetId, categoryId);
  }

  async getMonthCategoryById(
    budgetId: string,
    month: string,
    categoryId: string
  ): Promise<ynab.CategoryResponse> {
    await this.rateLimiter.acquire();
    return this.api.categories.getMonthCategoryById(budgetId, month, categoryId);
  }

  async updateMonthCategory(
    budgetId: string,
    month: string,
    categoryId: string,
    data: ynab.PatchMonthCategoryWrapper
  ): Promise<ynab.SaveCategoryResponse> {
    this.assertWriteAllowed('updateMonthCategory');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after updating
    this.cache.delete(`categories:${budgetId}`);

    const auditLog = getAuditLog();
    try {
      const response = await this.api.categories.updateMonthCategory(budgetId, month, categoryId, data);
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_category',
        budgetId,
        resourceType: 'category',
        resourceId: categoryId,
        details: { month, budgeted: data.category.budgeted },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_category',
        budgetId,
        resourceType: 'category',
        resourceId: categoryId,
        details: { month, budgeted: data.category.budgeted },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  // ==================== Transactions ====================

  async getTransactions(
    budgetId: string,
    options?: {
      sinceDate?: string;
      type?: 'uncategorized' | 'unapproved';
      lastKnowledgeOfServer?: number;
    }
  ): Promise<ynab.TransactionsResponse> {
    await this.rateLimiter.acquire();
    const response = await this.api.transactions.getTransactions(
      budgetId,
      options?.sinceDate,
      options?.type,
      options?.lastKnowledgeOfServer
    );
    
    if (response.data.server_knowledge !== undefined) {
      this.updateServerKnowledge(budgetId, response.data.server_knowledge);
    }
    
    return response;
  }

  async getTransactionById(
    budgetId: string,
    transactionId: string
  ): Promise<ynab.TransactionResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionById(budgetId, transactionId);
  }

  async createTransaction(
    budgetId: string,
    data: ynab.PostTransactionsWrapper
  ): Promise<ynab.SaveTransactionsResponse> {
    this.assertWriteAllowed('createTransaction');
    await this.rateLimiter.acquire();

    const auditLog = getAuditLog();
    const txn = data.transaction;
    try {
      const response = await this.api.transactions.createTransaction(budgetId, data);
      // Redact PII from audit logs - payee_name may contain personal information
      const logEntry: Parameters<typeof auditLog.log>[0] = {
        operation: 'create',
        tool: 'ynab_create_transaction',
        budgetId,
        resourceType: 'transaction',
        details: {
          amount: txn?.amount,
          date: txn?.date,
          has_payee: txn?.payee_name !== undefined && txn?.payee_name !== null,
          account_id: txn?.account_id,
        },
        success: true,
      };
      const createdId = response.data.transaction?.id;
      if (createdId !== undefined) logEntry.resourceId = createdId;
      auditLog.log(logEntry);
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_transaction',
        budgetId,
        resourceType: 'transaction',
        details: {
          amount: txn?.amount,
          date: txn?.date,
          has_payee: txn?.payee_name !== undefined && txn?.payee_name !== null,
          account_id: txn?.account_id,
        },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async updateTransaction(
    budgetId: string,
    transactionId: string,
    data: ynab.PutTransactionWrapper
  ): Promise<ynab.TransactionResponse> {
    this.assertWriteAllowed('updateTransaction');
    await this.rateLimiter.acquire();

    const auditLog = getAuditLog();
    const txn = data.transaction;
    try {
      const response = await this.api.transactions.updateTransaction(budgetId, transactionId, data);
      // Redact memo from audit logs - may contain sensitive user data
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_transaction',
        budgetId,
        resourceType: 'transaction',
        resourceId: transactionId,
        details: {
          amount: txn.amount,
          date: txn.date,
          has_memo: txn.memo !== undefined && txn.memo !== null && txn.memo !== '',
          category_id: txn.category_id,
        },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_transaction',
        budgetId,
        resourceType: 'transaction',
        resourceId: transactionId,
        details: {
          amount: txn.amount,
          date: txn.date,
          has_memo: txn.memo !== undefined && txn.memo !== null && txn.memo !== '',
          category_id: txn.category_id,
        },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async deleteTransaction(
    budgetId: string,
    transactionId: string
  ): Promise<ynab.TransactionResponse> {
    this.assertWriteAllowed('deleteTransaction');
    await this.rateLimiter.acquire();

    const auditLog = getAuditLog();
    try {
      const response = await this.api.transactions.deleteTransaction(budgetId, transactionId);
      // Redact PII from audit logs - payee_name may contain personal information
      auditLog.log({
        operation: 'delete',
        tool: 'ynab_delete_transaction',
        budgetId,
        resourceType: 'transaction',
        resourceId: transactionId,
        details: {
          deleted_amount: response.data.transaction.amount,
          deleted_date: response.data.transaction.date,
        },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'delete',
        tool: 'ynab_delete_transaction',
        budgetId,
        resourceType: 'transaction',
        resourceId: transactionId,
        details: {},
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async importTransactions(budgetId: string): Promise<ynab.TransactionsImportResponse> {
    this.assertWriteAllowed('importTransactions');
    await this.rateLimiter.acquire();

    const auditLog = getAuditLog();
    try {
      const response = await this.api.transactions.importTransactions(budgetId);
      auditLog.log({
        operation: 'create',
        tool: 'ynab_import_transactions',
        budgetId,
        resourceType: 'transaction',
        details: { imported_count: response.data.transaction_ids.length },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_import_transactions',
        budgetId,
        resourceType: 'transaction',
        details: {},
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async getAccountTransactions(
    budgetId: string,
    accountId: string,
    sinceDate?: string
  ): Promise<ynab.TransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionsByAccount(budgetId, accountId, sinceDate);
  }

  async getCategoryTransactions(
    budgetId: string,
    categoryId: string,
    sinceDate?: string
  ): Promise<ynab.HybridTransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionsByCategory(budgetId, categoryId, sinceDate);
  }

  async getPayeeTransactions(
    budgetId: string,
    payeeId: string,
    sinceDate?: string
  ): Promise<ynab.HybridTransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionsByPayee(budgetId, payeeId, sinceDate);
  }

  // ==================== Scheduled Transactions ====================

  async getScheduledTransactions(budgetId: string): Promise<ynab.ScheduledTransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.scheduledTransactions.getScheduledTransactions(budgetId);
  }

  async getScheduledTransactionById(
    budgetId: string,
    scheduledTransactionId: string
  ): Promise<ynab.ScheduledTransactionResponse> {
    await this.rateLimiter.acquire();
    return this.api.scheduledTransactions.getScheduledTransactionById(
      budgetId,
      scheduledTransactionId
    );
  }

  // Note: createScheduledTransaction is not available in the official YNAB JS SDK
  // The API supports it but the SDK doesn't expose it

  // ==================== Payees ====================

  async getPayees(budgetId: string): Promise<ynab.PayeesResponse> {
    const cacheKey = `payees:${budgetId}`;
    const cached = this.cache.get<ynab.PayeesResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.payees.getPayees(budgetId);
    this.cache.set(cacheKey, response);
    return response;
  }

  async getPayeeById(budgetId: string, payeeId: string): Promise<ynab.PayeeResponse> {
    await this.rateLimiter.acquire();
    return this.api.payees.getPayeeById(budgetId, payeeId);
  }

  // ==================== Payee Locations ====================

  async getPayeeLocations(budgetId: string): Promise<ynab.PayeeLocationsResponse> {
    await this.rateLimiter.acquire();
    return this.api.payeeLocations.getPayeeLocations(budgetId);
  }

  async getPayeeLocationById(
    budgetId: string,
    payeeLocationId: string
  ): Promise<ynab.PayeeLocationResponse> {
    await this.rateLimiter.acquire();
    return this.api.payeeLocations.getPayeeLocationById(budgetId, payeeLocationId);
  }

  async getPayeeLocationsByPayee(
    budgetId: string,
    payeeId: string
  ): Promise<ynab.PayeeLocationsResponse> {
    await this.rateLimiter.acquire();
    return this.api.payeeLocations.getPayeeLocationsByPayee(budgetId, payeeId);
  }

  // ==================== Months ====================

  async getBudgetMonths(budgetId: string): Promise<ynab.MonthSummariesResponse> {
    await this.rateLimiter.acquire();
    return this.api.months.getBudgetMonths(budgetId);
  }

  async getBudgetMonth(budgetId: string, month: string): Promise<ynab.MonthDetailResponse> {
    await this.rateLimiter.acquire();
    return this.api.months.getBudgetMonth(budgetId, month);
  }
}
