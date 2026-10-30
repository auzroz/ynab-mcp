/**
 * YNAB Client Wrapper
 *
 * Wraps the official YNAB SDK with rate limiting, caching, and read-only mode.
 */

import * as ynab from 'ynab';
import type { RateLimiter } from './rate-limiter.js';
import type { Cache } from './cache.js';
import { ReadOnlyModeError, YnabApiError } from '../utils/errors.js';
import { getAuditLog, type AuditLog } from './audit-log.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';
import { isBudgetIdSentinel } from '../utils/schemas.js';

// TEMPORARY WORKAROUND: the ynab SDK (4.5.0) drops `goal_frequency` when it
// serializes SaveCategory/NewCategory/ExistingCategory, so requests carrying it
// are sent straight to the API. Tracked in auzroz/ynab-mcp#22 and
// ynab/ynab-sdk-js#308. Delete the direct-call path (sendCategoryDirect and the
// goal_frequency branches below) once a regenerated SDK is released.
const YNAB_API_BASE_URL = 'https://api.ynab.com/v1'; // same as the SDK's BASE_PATH
const DIRECT_REQUEST_TIMEOUT_MS = 30_000;

type GoalFrequency = 'monthly' | 'weekly' | 'yearly';

/**
 * A fixed YNAB access token (stdio, header mode), or a function returning the
 * current one, called for every YNAB request (oauth mode, where the ~2h YNAB
 * token is refreshed under a long-lived session).
 */
export type AccessTokenSource = string | (() => Promise<string>);

/**
 * ynab.API built from a ready Configuration, so SDK middleware (the 429 hook)
 * can be attached for both fixed and per-request tokens.
 */
class ConfiguredApi extends ynab.API {
  constructor(configuration: ynab.Configuration) {
    super('');
    this._configuration = configuration;
  }
}

/** Create body: the SDK's NewCategory plus the field the SDK cannot send. */
export interface CreateCategoryBody {
  category: ynab.NewCategory & { goal_frequency?: GoalFrequency };
}

/** Audit details for category creation: presence flags only, no amounts or names. */
function createCategoryAuditDetails(data: CreateCategoryBody): Record<string, unknown> {
  const c = data.category;
  return {
    has_name: !!c.name,
    category_group_id: c.category_group_id,
    ...(c.goal_target !== undefined ? { has_goal_target: true } : {}),
    ...(c.goal_target_date !== undefined ? { has_goal_target_date: true } : {}),
    ...(c.goal_needs_whole_amount !== undefined ? { has_goal_needs_whole_amount: true } : {}),
    ...(c.goal_frequency !== undefined ? { has_goal_frequency: true } : {}),
  };
}

/**
 * Request body for updateCategory. The API (SaveCategory) accepts null to clear
 * name/note/target values, but the SDK's ExistingCategory type only declares the
 * non-null forms, so the body is typed with SaveCategory and cast at the SDK call.
 * The SDK serializer passes values (including null) through unchanged.
 */
export interface UpdateCategoryBody {
  category: ynab.SaveCategory & { goal_frequency?: GoalFrequency };
}

/** Audit details for category detail updates: presence flags only, no names, notes or amounts. */
function updateCategoryDetailsAuditDetails(data: UpdateCategoryBody): Record<string, unknown> {
  const c = data.category;
  return {
    ...(c.name !== undefined ? { has_name: true } : {}),
    ...(c.note !== undefined ? { has_note: true } : {}),
    ...(c.category_group_id !== undefined ? { category_group_id: c.category_group_id } : {}),
    ...(c.goal_target !== undefined ? { has_goal_target: true } : {}),
    ...(c.goal_target_date !== undefined ? { has_goal_target_date: true } : {}),
    ...(c.goal_needs_whole_amount !== undefined ? { has_goal_needs_whole_amount: true } : {}),
    ...(c.goal_frequency !== undefined ? { has_goal_frequency: true } : {}),
  };
}

export class YnabClient {
  private readonly api: ynab.API;
  // Only used by the goal_frequency direct-call workaround; never logged.
  private readonly getAccessToken: () => Promise<string>;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: Cache;
  private readonly defaultBudgetId: string;
  private readonly readOnly: boolean;
  private readonly auditLog: AuditLog;

  // Track server knowledge for delta sync. Keyed by budget, resource and any
  // request parameters that change the result set (see knowledgeKey), because a
  // cursor is only valid for the endpoint and query that produced it.
  private serverKnowledge: Map<string, number> = new Map();

  constructor(
    accessToken: AccessTokenSource,
    defaultBudgetId: string | undefined,
    rateLimiter: RateLimiter,
    cache: Cache,
    readOnly = true,
    // Injected per-instance audit log. Defaults to the process-wide singleton so
    // single-user (stdio) usage is unchanged; multi-tenant callers pass a
    // per-user instance so one user's write history never leaks to another.
    auditLog: AuditLog = getAuditLog()
  ) {
    // Every YNAB response passes this hook; a 429 marks the limiter exhausted.
    const middleware: ynab.Middleware[] = [
      {
        post: async ({ response }) => {
          if (response.status === 429) throw this.noteYnabRateLimited(response);
          return undefined;
        },
      },
    ];
    if (typeof accessToken === 'string') {
      this.api = new ConfiguredApi(
        new ynab.Configuration({ accessToken, basePath: ynab.BASE_PATH, middleware })
      );
      this.getAccessToken = () => Promise.resolve(accessToken);
    } else {
      // Every request takes a rate-limit token before resolving its access
      // token; when resolution fails nothing reaches YNAB, so give it back.
      this.getAccessToken = async () => {
        try {
          return await accessToken();
        } catch (error) {
          this.rateLimiter.release();
          throw error;
        }
      };
      this.api = new ConfiguredApi(
        new ynab.Configuration({ accessToken: this.getAccessToken, basePath: ynab.BASE_PATH, middleware })
      );
    }
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
   * Build the delta-sync key for one endpoint + query within a budget.
   * `resource` names the endpoint (e.g. "budget", "transactions"); `params`
   * are the request parameters that change which records come back, so a
   * cursor from a filtered query is never reused for a different one.
   */
  private knowledgeKey(
    budgetId: string,
    resource: string,
    params: Record<string, string | undefined> = {}
  ): string {
    const query = Object.keys(params)
      .filter((k) => params[k] !== undefined)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return JSON.stringify([budgetId, resource, query]);
  }

  /**
   * Get server knowledge for one endpoint of a budget (used for delta sync).
   * Only valid for the same resource and params it was recorded with.
   */
  getServerKnowledge(
    budgetId: string,
    resource: string,
    params?: Record<string, string | undefined>
  ): number | undefined {
    return this.serverKnowledge.get(this.knowledgeKey(budgetId, resource, params));
  }

  /**
   * Update server knowledge for one endpoint after a response.
   */
  updateServerKnowledge(
    budgetId: string,
    knowledge: number,
    resource: string,
    params?: Record<string, string | undefined>
  ): void {
    this.serverKnowledge.set(this.knowledgeKey(budgetId, resource, params), knowledge);
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

    const generation = this.cache.generation();
    await this.rateLimiter.acquire();
    const response = await this.api.plans.getPlans(includeAccounts);
    if (generation === this.cache.generation()) this.cache.set(cacheKey, response);
    return response;
  }

  async getBudgetById(
    budgetId: string,
    lastKnowledgeOfServer?: number
  ): Promise<ynab.PlanDetailResponse> {
    await this.rateLimiter.acquire();
    const response = await this.api.plans.getPlanById(budgetId, lastKnowledgeOfServer);

    if (response.data.server_knowledge !== undefined) {
      this.updateServerKnowledge(budgetId, response.data.server_knowledge, 'budget');
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

  /**
   * Returns the budget's first month (YYYY-MM-01), used to derive an explicit
   * since_date because YNAB API 1.85+ defaults since_date to one year ago.
   * Resolved from the cached budget list when possible (no extra request);
   * otherwise falls back to the earliest budget month. Cached per explicit budget
   * ID and invalidated by transaction writes, which can extend a budget's history.
   */
  async getBudgetFirstMonth(budgetId: string): Promise<string | undefined> {
    // "last-used" and "default" can point at a different budget over time, so
    // results for them are never cached under the alias.
    const isAlias = isBudgetIdSentinel(budgetId);
    const cacheKey = `first-month:${budgetId}`;
    if (!isAlias) {
      const cached = this.cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;
    }

    const generation = this.cache.generation();
    let firstMonth: string | undefined;
    // Match the cached budget list by exact ID only. Aliases (and IDs missing from
    // the list) never borrow another budget's first month; they use the month list.
    const budgets = (await this.getBudgets()).data.plans;
    firstMonth = budgets.find((b) => b.id === budgetId)?.first_month;

    if (firstMonth === undefined) {
      // Aliases and unlisted IDs: derive from the (uncached) month list
      const months = (await this.getBudgetMonths(budgetId)).data.months;
      for (const m of months) {
        if (firstMonth === undefined || m.month < firstMonth) firstMonth = m.month;
      }
    }

    if (firstMonth !== undefined && !isAlias && generation === this.cache.generation()) {
      this.cache.set(cacheKey, firstMonth);
    }
    return firstMonth;
  }

  /**
   * Drop cached data derived from transaction history (the budget's first month
   * and the budget list that carries it) after a successful transaction write.
   */
  private invalidateTransactionHistory(budgetId: string): void {
    // The generation is the cache's, so it also guards reads in flight in the
    // user's other sessions (HTTP mode shares the cache between them).
    this.cache.bumpGeneration();
    if (isBudgetIdSentinel(budgetId)) {
      // An alias write could have touched any budget, so drop every cached first month.
      this.cache.deleteByPrefix('first-month:');
    } else {
      this.cache.delete(`first-month:${budgetId}`);
    }
    this.cache.delete('budgets:false');
    this.cache.delete('budgets:true');
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
    // An assignment creates a money movement and group; drop the cached group
    // reads (both the whole-budget and per-month keys share this prefix).
    this.cache.deleteByPrefix(`money-movement-groups:${budgetId}`);

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

  /**
   * Update a category's details (name, note, group, target) via PATCH
   * /plans/{plan_id}/categories/{category_id}. Distinct from updateMonthCategory,
   * which only changes a month's budgeted amount.
   */
  async updateCategory(
    budgetId: string,
    categoryId: string,
    data: UpdateCategoryBody
  ): Promise<ynab.SaveCategoryResponse> {
    this.assertWriteAllowed('updateCategory');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after updating (names, groups and targets all change)
    this.cache.delete(`categories:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response =
        data.category.goal_frequency !== undefined
          ? await this.sendCategoryDirect(
              'PATCH',
              `/plans/${encodeURIComponent(budgetId)}/categories/${encodeURIComponent(categoryId)}`,
              data
            )
          : await this.api.categories.updateCategory(
              budgetId,
              categoryId,
              data as ynab.PatchCategoryWrapper
            );
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_category_details',
        budgetId,
        resourceType: 'category',
        resourceId: categoryId,
        details: updateCategoryDetailsAuditDetails(data),
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'update',
        tool: 'ynab_update_category_details',
        budgetId,
        resourceType: 'category',
        resourceId: categoryId,
        details: updateCategoryDetailsAuditDetails(data),
        success: false,
        error: sanitizeErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * YNAB answered 429: stop the limiter sending requests until YNAB's window
   * resets (Retry-After when sent) and return the mapped error to throw. Only
   * the status and the Retry-After header are read; no response text.
   */
  private noteYnabRateLimited(response: Response): YnabApiError {
    const windowMs = this.rateLimiter.markExhaustedByYnab(response.headers.get('retry-after'));
    return new YnabApiError('YNAB API request failed', '429', undefined, Math.ceil(windowMs / 1000));
  }

  /**
   * Send a category write straight to the YNAB API (see the workaround note at
   * the top of this file). Non-2xx responses throw a YnabApiError carrying only
   * the HTTP status, so formatErrorResponse returns its mapped generic message;
   * upstream response text is never read into an error.
   */
  private async sendCategoryDirect(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown
  ): Promise<ynab.SaveCategoryResponse> {
    // Resolved per request, like the SDK path, so a refreshed token is used.
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${YNAB_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DIRECT_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Release the connection without reading upstream text into the error.
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) throw this.noteYnabRateLimited(response);
      throw new YnabApiError('YNAB API request failed', String(response.status));
    }
    return (await response.json()) as ynab.SaveCategoryResponse;
  }

  async createCategory(
    budgetId: string,
    data: CreateCategoryBody
  ): Promise<ynab.SaveCategoryResponse> {
    this.assertWriteAllowed('createCategory');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after creating
    this.cache.delete(`categories:${budgetId}`);

    const auditLog = this.auditLog;
    try {
      const response =
        data.category.goal_frequency !== undefined
          ? await this.sendCategoryDirect(
              'POST',
              `/plans/${encodeURIComponent(budgetId)}/categories`,
              data
            )
          : await this.api.categories.createCategory(budgetId, data);
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_category',
        budgetId,
        resourceType: 'category',
        resourceId: response.data.category.id,
        // Category names may be sensitive; log only presence and grouping.
        details: createCategoryAuditDetails(data),
        success: true,
      });
      return response;
    } catch (error) {
      auditLog.log({
        operation: 'create',
        tool: 'ynab_create_category',
        budgetId,
        resourceType: 'category',
        details: createCategoryAuditDetails(data),
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
      /** Inclusive upper bound (ynab SDK 4.5+); undefined means no upper bound. */
      untilDate?: string;
      type?: 'uncategorized' | 'unapproved';
      lastKnowledgeOfServer?: number;
    }
  ): Promise<ynab.TransactionsResponse> {
    await this.rateLimiter.acquire();
    const response = await this.api.transactions.getTransactions(
      budgetId,
      options?.sinceDate,
      options?.untilDate,
      options?.type,
      options?.lastKnowledgeOfServer
    );

    if (response.data.server_knowledge !== undefined) {
      this.updateServerKnowledge(budgetId, response.data.server_knowledge, 'transactions', {
        sinceDate: options?.sinceDate,
        untilDate: options?.untilDate,
        type: options?.type,
      });
    }

    return response;
  }

  /** Transactions for one plan month (YYYY-MM-01 or "current"). Not cached, like getTransactions. */
  async getTransactionsByMonth(
    budgetId: string,
    month: string,
    options?: {
      sinceDate?: string;
      untilDate?: string;
      type?: 'uncategorized' | 'unapproved';
      lastKnowledgeOfServer?: number;
    }
  ): Promise<ynab.TransactionsResponse> {
    await this.rateLimiter.acquire();
    const response = await this.api.transactions.getTransactionsByMonth(
      budgetId,
      month,
      options?.sinceDate,
      options?.untilDate,
      options?.type,
      options?.lastKnowledgeOfServer
    );

    if (response.data.server_knowledge !== undefined) {
      this.updateServerKnowledge(budgetId, response.data.server_knowledge, 'transactions-by-month', {
        month,
        sinceDate: options?.sinceDate,
        untilDate: options?.untilDate,
        type: options?.type,
      });
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
      this.invalidateTransactionHistory(budgetId);
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
      this.invalidateTransactionHistory(budgetId);
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
      this.invalidateTransactionHistory(budgetId);
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
      this.invalidateTransactionHistory(budgetId);
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

  async getAccountTransactions(
    budgetId: string,
    accountId: string,
    sinceDate?: string,
    untilDate?: string
  ): Promise<ynab.TransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionsByAccount(
      budgetId,
      accountId,
      sinceDate,
      untilDate
    );
  }

  async getCategoryTransactions(
    budgetId: string,
    categoryId: string,
    sinceDate?: string,
    untilDate?: string
  ): Promise<ynab.HybridTransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionsByCategory(
      budgetId,
      categoryId,
      sinceDate,
      untilDate
    );
  }

  async getPayeeTransactions(
    budgetId: string,
    payeeId: string,
    sinceDate?: string,
    untilDate?: string
  ): Promise<ynab.HybridTransactionsResponse> {
    await this.rateLimiter.acquire();
    return this.api.transactions.getTransactionsByPayee(
      budgetId,
      payeeId,
      sinceDate,
      untilDate
    );
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

  async getMoneyMovementsByMonth(
    budgetId: string,
    month: string
  ): Promise<ynab.MoneyMovementsResponse> {
    await this.rateLimiter.acquire();
    return this.api.money_movements.getMoneyMovementsByMonth(budgetId, month);
  }

  /**
   * Money movement groups, cached like the other metadata reads (not under the
   * "last-used"/"default" aliases, which can point at a different budget later).
   */
  async getMoneyMovementGroups(budgetId: string): Promise<ynab.MoneyMovementGroupsResponse> {
    return this.cachedMoneyMovementGroups(budgetId, `money-movement-groups:${budgetId}`, () =>
      this.api.money_movements.getMoneyMovementGroups(budgetId)
    );
  }

  async getMoneyMovementGroupsByMonth(
    budgetId: string,
    month: string
  ): Promise<ynab.MoneyMovementGroupsResponse> {
    return this.cachedMoneyMovementGroups(
      budgetId,
      // "current" moves with the calendar, so it is never cached under that name.
      month === 'current' ? undefined : `money-movement-groups:${budgetId}:${month}`,
      () => this.api.money_movements.getMoneyMovementGroupsByMonth(budgetId, month)
    );
  }

  private async cachedMoneyMovementGroups(
    budgetId: string,
    cacheKey: string | undefined,
    fetchGroups: () => Promise<ynab.MoneyMovementGroupsResponse>
  ): Promise<ynab.MoneyMovementGroupsResponse> {
    const cacheable = cacheKey !== undefined && !isBudgetIdSentinel(budgetId);
    if (cacheable) {
      const cached = this.cache.get<ynab.MoneyMovementGroupsResponse>(cacheKey);
      if (cached !== undefined) return cached;
    }
    await this.rateLimiter.acquire();
    const response = await fetchGroups();
    if (cacheable) this.cache.set(cacheKey, response);
    return response;
  }
}
