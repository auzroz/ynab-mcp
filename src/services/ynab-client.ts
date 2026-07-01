/**
 * YNAB Client Wrapper
 *
 * Wraps the official YNAB SDK with rate limiting, caching, and read-only mode.
 */

import * as ynab from 'ynab';
import type { RateLimiter } from './rate-limiter.js';
import type { Cache } from './cache.js';
import { ReadOnlyModeError } from '../utils/errors.js';
import { getAuditLog, type AuditLog } from './audit-log.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

export class YnabClient {
  private readonly api: ynab.API;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: Cache;
  private readonly defaultBudgetId: string;
  private readonly readOnly: boolean;
  private readonly auditLog: AuditLog;

  // Track server knowledge for delta sync
  private serverKnowledge: Map<string, number> = new Map();

  constructor(
    accessToken: string,
    defaultBudgetId: string | undefined,
    rateLimiter: RateLimiter,
    cache: Cache,
    readOnly = true,
    // Injected per-instance audit log. Defaults to the process-wide singleton so
    // single-user (stdio) usage is unchanged; multi-tenant callers pass a
    // per-user instance so one user's write history never leaks to another.
    auditLog: AuditLog = getAuditLog()
  ) {
    this.api = new ynab.API(accessToken);
    this.rateLimiter = rateLimiter;
    this.cache = cache;
    this.defaultBudgetId = defaultBudgetId ?? 'last-used';
    this.readOnly = readOnly;
    this.auditLog = auditLog;
  }

  /**
   * Check if the client is in read-only mode.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Get this client's audit log instance (per-user in multi-tenant mode).
   */
  getAuditLog(): AuditLog {
    return this.auditLog;
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
   *
   * Design Decision: budget_id is intentionally not validated as a UUID.
   * The YNAB API accepts both UUIDs and the special sentinel value "last-used"
   * to reference the most recently accessed budget. Rather than maintaining a
   * union type that could break if YNAB adds more special values, we accept
   * any string and let the YNAB API validate it. This provides better forward
   * compatibility and clearer error messages from the source of truth.
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

  async getBudgets(includeAccounts = false): Promise<ynab.PlanSummaryResponse> {
    const cacheKey = `budgets:${includeAccounts}`;
    const cached = this.cache.get<ynab.PlanSummaryResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.plans.getPlans(includeAccounts);
    this.cache.set(cacheKey, response);
    return response;
  }

  async getBudgetById(
    budgetId: string,
    lastKnowledgeOfServer?: number
  ): Promise<ynab.PlanDetailResponse> {
    await this.rateLimiter.acquire();
    const response = await this.api.plans.getPlanById(budgetId, lastKnowledgeOfServer);

    if (response.data.server_knowledge !== undefined) {
      this.updateServerKnowledge(budgetId, response.data.server_knowledge);
    }

    return response;
  }

  async getBudgetSettingsById(budgetId: string): Promise<ynab.PlanSettingsResponse> {
    const cacheKey = `budget-settings:${budgetId}`;
    const cached = this.cache.get<ynab.PlanSettingsResponse>(cacheKey);
    if (cached !== undefined) return cached;

    await this.rateLimiter.acquire();
    const response = await this.api.plans.getPlanSettingsById(budgetId);
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
    // Also invalidate budgets cache since getBudgets(true) includes account data
    this.cache.delete(`accounts:${budgetId}`);
    // Only invalidate budgets:true since getBudgets(false) doesn't include account data
    this.cache.delete('budgets:true');

    const auditLog = this.auditLog;
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

    const auditLog = this.auditLog;
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

  async createCategory(
    budgetId: string,
    data: ynab.PostCategoryWrapper
  ): Promise<ynab.SaveCategoryResponse> {
    this.assertWriteAllowed('createCategory');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after creating
    this.cache.delete(`categories:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response = await this.api.categories.createCategory(budgetId, data);
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_category',
        budgetId,
        resourceType: 'category',
        resourceId: response.data.category.id,
        // Category names may be sensitive; log only presence and grouping.
        details: { has_name: !!data.category.name, category_group_id: data.category.category_group_id },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_category',
        budgetId,
        resourceType: 'category',
        details: { has_name: !!data.category.name, category_group_id: data.category.category_group_id },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async createCategoryGroup(
    budgetId: string,
    data: ynab.PostCategoryGroupWrapper
  ): Promise<ynab.SaveCategoryGroupResponse> {
    this.assertWriteAllowed('createCategoryGroup');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after creating (groups are returned with categories)
    this.cache.delete(`categories:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response = await this.api.categories.createCategoryGroup(budgetId, data);
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_category_group',
        budgetId,
        resourceType: 'category_group',
        resourceId: response.data.category_group.id,
        details: { has_name: !!data.category_group.name },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_category_group',
        budgetId,
        resourceType: 'category_group',
        details: { has_name: !!data.category_group.name },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async updateCategoryGroup(
    budgetId: string,
    categoryGroupId: string,
    data: ynab.PatchCategoryGroupWrapper
  ): Promise<ynab.SaveCategoryGroupResponse> {
    this.assertWriteAllowed('updateCategoryGroup');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after updating
    this.cache.delete(`categories:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response = await this.api.categories.updateCategoryGroup(
        budgetId,
        categoryGroupId,
        data
      );
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_category_group',
        budgetId,
        resourceType: 'category_group',
        resourceId: categoryGroupId,
        details: { has_name: !!data.category_group.name },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_category_group',
        budgetId,
        resourceType: 'category_group',
        resourceId: categoryGroupId,
        details: { has_name: !!data.category_group.name },
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

    const auditLog = this.auditLog;
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

    const auditLog = this.auditLog;
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

  async updateTransactions(
    budgetId: string,
    data: ynab.PatchTransactionsWrapper
  ): Promise<ynab.SaveTransactionsResponse> {
    this.assertWriteAllowed('updateTransactions');
    await this.rateLimiter.acquire();

    const auditLog = this.auditLog;
    try {
      const response = await this.api.transactions.updateTransactions(budgetId, data);
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_transactions',
        budgetId,
        resourceType: 'transaction',
        // Bulk operation; log counts only (no PII).
        details: {
          requested_count: data.transactions.length,
          updated_count: response.data.transaction_ids.length,
        },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_transactions',
        budgetId,
        resourceType: 'transaction',
        details: { requested_count: data.transactions.length },
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

    const auditLog = this.auditLog;
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

    const auditLog = this.auditLog;
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

  async createScheduledTransaction(
    budgetId: string,
    data: ynab.PostScheduledTransactionWrapper
  ): Promise<ynab.ScheduledTransactionResponse> {
    this.assertWriteAllowed('createScheduledTransaction');
    await this.rateLimiter.acquire();

    const auditLog = this.auditLog;
    const txn = data.scheduled_transaction;
    try {
      const response = await this.api.scheduledTransactions.createScheduledTransaction(
        budgetId,
        data
      );
      // Redact PII from audit logs - payee_name may contain personal information
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_scheduled_transaction',
        budgetId,
        resourceType: 'scheduled_transaction',
        resourceId: response.data.scheduled_transaction.id,
        details: {
          amount: txn?.amount,
          date: txn?.date,
          frequency: txn?.frequency,
          has_payee: txn?.payee_name !== undefined && txn?.payee_name !== null,
          account_id: txn?.account_id,
        },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_scheduled_transaction',
        budgetId,
        resourceType: 'scheduled_transaction',
        details: {
          amount: txn?.amount,
          date: txn?.date,
          frequency: txn?.frequency,
          has_payee: txn?.payee_name !== undefined && txn?.payee_name !== null,
          account_id: txn?.account_id,
        },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async updateScheduledTransaction(
    budgetId: string,
    scheduledTransactionId: string,
    data: ynab.PutScheduledTransactionWrapper
  ): Promise<ynab.ScheduledTransactionResponse> {
    this.assertWriteAllowed('updateScheduledTransaction');
    await this.rateLimiter.acquire();

    const auditLog = this.auditLog;
    const txn = data.scheduled_transaction;
    try {
      const response = await this.api.scheduledTransactions.updateScheduledTransaction(
        budgetId,
        scheduledTransactionId,
        data
      );
      // Redact memo from audit logs - may contain sensitive user data
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_scheduled_transaction',
        budgetId,
        resourceType: 'scheduled_transaction',
        resourceId: scheduledTransactionId,
        details: {
          amount: txn?.amount,
          date: txn?.date,
          frequency: txn?.frequency,
          has_memo: txn?.memo !== undefined && txn?.memo !== null && txn?.memo !== '',
          category_id: txn?.category_id,
        },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_scheduled_transaction',
        budgetId,
        resourceType: 'scheduled_transaction',
        resourceId: scheduledTransactionId,
        details: {
          amount: txn?.amount,
          date: txn?.date,
          frequency: txn?.frequency,
          has_memo: txn?.memo !== undefined && txn?.memo !== null && txn?.memo !== '',
          category_id: txn?.category_id,
        },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async deleteScheduledTransaction(
    budgetId: string,
    scheduledTransactionId: string
  ): Promise<ynab.ScheduledTransactionResponse> {
    this.assertWriteAllowed('deleteScheduledTransaction');
    await this.rateLimiter.acquire();

    const auditLog = this.auditLog;
    try {
      const response = await this.api.scheduledTransactions.deleteScheduledTransaction(
        budgetId,
        scheduledTransactionId
      );
      // Redact PII from audit logs - payee_name may contain personal information
      auditLog.log({
        operation: 'delete',
        tool: 'ynab_delete_scheduled_transaction',
        budgetId,
        resourceType: 'scheduled_transaction',
        resourceId: scheduledTransactionId,
        details: {
          deleted_amount: response.data.scheduled_transaction.amount,
          deleted_date: response.data.scheduled_transaction.date_next,
        },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'delete',
        tool: 'ynab_delete_scheduled_transaction',
        budgetId,
        resourceType: 'scheduled_transaction',
        resourceId: scheduledTransactionId,
        details: {},
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

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

  async createPayee(
    budgetId: string,
    data: ynab.PostPayeeWrapper
  ): Promise<ynab.SavePayeeResponse> {
    this.assertWriteAllowed('createPayee');
    await this.rateLimiter.acquire();
    // Invalidate payees cache after creating
    this.cache.delete(`payees:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response = await this.api.payees.createPayee(budgetId, data);
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_payee',
        budgetId,
        resourceType: 'payee',
        resourceId: response.data.payee.id,
        // Payee names are PII; log only presence.
        details: { has_name: !!data.payee.name },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_payee',
        budgetId,
        resourceType: 'payee',
        details: { has_name: !!data.payee.name },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  async updatePayee(
    budgetId: string,
    payeeId: string,
    data: ynab.PatchPayeeWrapper
  ): Promise<ynab.SavePayeeResponse> {
    this.assertWriteAllowed('updatePayee');
    await this.rateLimiter.acquire();
    // Invalidate payees cache after updating
    this.cache.delete(`payees:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response = await this.api.payees.updatePayee(budgetId, payeeId, data);
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_payee',
        budgetId,
        resourceType: 'payee',
        resourceId: payeeId,
        // Payee names are PII; log only presence.
        details: { has_name: !!data.payee.name },
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_payee',
        budgetId,
        resourceType: 'payee',
        resourceId: payeeId,
        details: { has_name: !!data.payee.name },
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
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
    return this.api.months.getPlanMonths(budgetId);
  }

  async getBudgetMonth(budgetId: string, month: string): Promise<ynab.MonthDetailResponse> {
    await this.rateLimiter.acquire();
    return this.api.months.getPlanMonth(budgetId, month);
  }

  // ==================== Money Movements ====================

  async getMoneyMovements(budgetId: string): Promise<ynab.MoneyMovementsResponse> {
    await this.rateLimiter.acquire();
    return this.api.money_movements.getMoneyMovements(budgetId);
  }
}
