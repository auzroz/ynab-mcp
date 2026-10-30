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
import { DeltaCache, type Snapshot } from './delta-cache.js';
import {
  DeltaMergeError,
  countCategoryEntities,
  countTransactionEntities,
  mergeBy,
  mergeById,
  mergeCategoryGroups,
  mergeTransactions,
  orderLike,
  withoutDeletedSubtransactions,
} from './delta-merge.js';

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
 * ynab.API that resolves its bearer token per request. The SDK's runtime
 * Configuration accepts a token function, but ynab.API's constructor is typed
 * for a string, so this swaps in such a Configuration before any endpoint
 * accessor (which builds its API class lazily from it) has been used.
 */
class TokenProviderApi extends ynab.API {
  constructor(getAccessToken: () => Promise<string>) {
    super('');
    this._configuration = new ynab.Configuration({ accessToken: getAccessToken, basePath: ynab.BASE_PATH });
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

/** Query options for the account/category/payee transaction endpoints. */
export interface ScopedTransactionOptions {
  sinceDate?: string | undefined;
  /** Inclusive upper bound (ynab SDK 4.5+); undefined means no upper bound. */
  untilDate?: string | undefined;
  type?: 'uncategorized' | 'unapproved' | undefined;
  lastKnowledgeOfServer?: number | undefined;
}

/** Query options for the budget-wide and month transaction endpoints. */
export interface TransactionListOptions {
  sinceDate?: string | undefined;
  /** Inclusive upper bound (ynab SDK 4.5+); undefined means no upper bound. */
  untilDate?: string | undefined;
  type?: 'uncategorized' | 'unapproved' | undefined;
  /**
   * Caller's delta cursor: when set, the response holds only what changed since
   * this knowledge (deleted entities with deleted: true), straight from YNAB.
   */
  lastKnowledgeOfServer?: number | undefined;
}

/** Options for list reads of resources without query filters (accounts, categories, ...). */
export interface DeltaReadOptions {
  /** Caller's delta cursor; see TransactionListOptions.lastKnowledgeOfServer. */
  lastKnowledgeOfServer?: number | undefined;
}

/** Any list response: its data carries the server_knowledge it reflects. */
interface KnowledgeResponse {
  data: { server_knowledge?: number | undefined };
}

/** How one list endpoint is read through the delta snapshot store (see snapshotRead). */
interface SnapshotRead<R extends KnowledgeResponse> {
  budgetId: string;
  /** Endpoint name, as used by the server-knowledge key. */
  resource: string;
  /** Request parameters that change the result set (part of every key). */
  params?: Record<string, string | undefined>;
  /** TTL cache key, for resources served from the TTL cache between refreshes. */
  ttlKey?: string;
  /**
   * Extra snapshot-key part for results that depend on the date: YNAB's
   * default 12-month window moves daily, so such snapshots are per UTC day.
   */
  window?: string;
  /** false when the query must always be fetched in full (see snapshotKey). */
  snapshot?: boolean;
  /** The caller's delta cursor (since_server_knowledge), if any. */
  cursor?: number | undefined;
  /**
   * Send this endpoint's request (taking a rate-limit token is the caller's
   * job); lastKnowledgeOfServer undefined means a full fetch.
   */
  fetch: (lastKnowledgeOfServer: number | undefined) => Promise<R>;
  /**
   * Bring a snapshot up to date: the full result as of a newer knowledge, or
   * undefined when it can't be done exactly (then a full fetch follows). Takes
   * its own rate-limit tokens; throws DeltaMergeError for a delta that doesn't
   * apply.
   */
  refresh: (base: R, knowledge: number) => Promise<R | undefined>;
  /**
   * Apply a delta of this same endpoint to a full result, for endpoints whose
   * deltas are complete (no query filters). The cursor path uses it to keep the
   * snapshot current with the caller's delta.
   */
  merge?: ((base: R, delta: R) => R) | undefined;
  /** A copy whose arrays the caller can't reach (tools sort results in place). */
  copy: (response: R) => R;
  /** Entity count, for the snapshot store's memory bound. */
  size: (response: R) => number;
}

function isKnowledge(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Shallow copy of a response with some data fields replaced. */
function withData<R extends { data: object }>(response: R, data: Partial<R['data']>): R {
  return { ...response, data: { ...response.data, ...data } };
}

interface FilterableTransaction {
  date: string;
  approved: boolean;
  account_id?: string;
}

/** Days either side of the estimated default-window start that count as ambiguous. */
const DEFAULT_WINDOW_MARGIN_DAYS = 3;

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A transaction query's filters in local form, used to place each transaction
 * of the budget's change feed into or out of a snapshot.
 * - `core(t)`: the filters that can be checked exactly from the transaction
 *   (since/until dates, month, unapproved, account);
 * - `keep(t)`: whether `t` belongs in the result (core plus YNAB's default
 *   12-month window when there is no since_date);
 * - `ambiguous(t)`: membership can't be told locally (the "uncategorized"
 *   type, or a date too close to the default window's start, whose exact day
 *   depends on YNAB's clock). A refresh that meets an ambiguous change that
 *   could concern the snapshot falls back to a full fetch.
 */
interface TransactionQueryModel {
  core: (t: FilterableTransaction) => boolean;
  keep: (t: FilterableTransaction) => boolean;
  ambiguous: (t: FilterableTransaction) => boolean;
}

function transactionQueryModel(
  q: {
    sinceDate?: string | undefined;
    untilDate?: string | undefined;
    type?: 'uncategorized' | 'unapproved' | undefined;
    month?: string | undefined;
    accountId?: string | undefined;
  },
  today: string
): TransactionQueryModel {
  const checks: Array<(t: FilterableTransaction) => boolean> = [];
  const { sinceDate: since, untilDate: until, accountId } = q;
  if (since !== undefined) checks.push((t) => t.date >= since);
  if (until !== undefined) checks.push((t) => t.date <= until);
  const month = q.month;
  if (month !== undefined) {
    const prefix = month.slice(0, 8); // "YYYY-MM-"
    checks.push((t) => t.date.startsWith(prefix));
  }
  if (q.type === 'unapproved') checks.push((t) => !t.approved);
  if (accountId !== undefined) checks.push((t) => t.account_id === accountId);
  const core = (t: FilterableTransaction): boolean => checks.every((check) => check(t));

  const ambiguities: Array<(t: FilterableTransaction) => boolean> = [];
  if (q.type === 'uncategorized') ambiguities.push(() => true);
  let keep = core;
  if (since === undefined) {
    // YNAB defaults since_date to about a year ago (API 1.85+).
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    const windowStart = d.toISOString().slice(0, 10);
    const low = addDays(windowStart, -DEFAULT_WINDOW_MARGIN_DAYS);
    const high = addDays(windowStart, DEFAULT_WINDOW_MARGIN_DAYS);
    if (month === undefined) {
      keep = (t) => core(t) && t.date >= windowStart;
      ambiguities.push((t) => t.date >= low && t.date <= high);
    } else if (month < high) {
      // Whether the default window applies to the month endpoint isn't
      // documented; it can only matter for a month that reaches back to it.
      ambiguities.push(() => true);
    }
  }
  return { core, keep, ambiguous: (t) => ambiguities.some((a) => a(t)) };
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
  private readonly deltaCache: DeltaCache;

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
    auditLog: AuditLog = getAuditLog(),
    // Delta-sync snapshots. Per user like the cache (HTTP sessions of one user
    // share it); a client built without one gets its own.
    deltaCache: DeltaCache = new DeltaCache()
  ) {
    if (typeof accessToken === 'string') {
      this.api = new ynab.API(accessToken);
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
      this.api = new TokenProviderApi(this.getAccessToken);
    }
    this.rateLimiter = rateLimiter;
    this.cache = cache;
    this.defaultBudgetId = defaultBudgetId ?? 'last-used';
    this.readOnly = readOnly;
    this.auditLog = auditLog;
    this.deltaCache = deltaCache;
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

  // ==================== Delta sync ====================

  /**
   * Snapshot-store key for a read, or undefined when the query must always be
   * fetched in full: budget aliases ("last-used", "default") can point at a
   * different budget over time, and a delta from one budget merged into
   * another's entities would corrupt the result.
   */
  private snapshotKey<R extends KnowledgeResponse>(spec: SnapshotRead<R>): string | undefined {
    if (spec.snapshot === false || isBudgetIdSentinel(spec.budgetId)) return undefined;
    return JSON.stringify([this.knowledgeKey(spec.budgetId, spec.resource, spec.params), spec.window ?? '']);
  }

  /** UTC day, for SnapshotRead.window. */
  private snapshotDay(): string {
    return new Date(this.deltaCache.now()).toISOString().slice(0, 10);
  }

  /**
   * Read a list endpoint through the TTL cache and the delta snapshot store.
   *
   * 1. A TTL cache hit is returned as before (resources that have a TTL key).
   * 2. Otherwise, with a snapshot for this exact query, YNAB is asked only for
   *    what changed since the snapshot's knowledge and the delta is merged into
   *    it; the merged FULL result is returned and becomes the new snapshot.
   * 3. With no snapshot, or when the delta can't be trusted (no or backwards
   *    server_knowledge, a merge that doesn't apply, a failed request), the
   *    snapshot is dropped and the endpoint is fetched in full.
   *
   * Callers always get the complete set a full fetch would return. Writes drop
   * the TTL entry (and bump the cache generation) but leave the snapshot, so the
   * next read is a small delta. The generation guards only the TTL store: a read
   * that started before a write must not cache its result. Snapshots don't need
   * that guard, since they are ordered by server_knowledge (DeltaCache.offer)
   * and every read refreshes one from YNAB before using it.
   */
  private async snapshotRead<R extends KnowledgeResponse>(spec: SnapshotRead<R>): Promise<R> {
    if (spec.cursor !== undefined) return this.cursorRead(spec, spec.cursor);

    if (spec.ttlKey !== undefined) {
      const cached = this.cache.get<R>(spec.ttlKey);
      if (cached !== undefined) return cached;
    }

    const generation = this.cache.generation();
    const key = this.snapshotKey(spec);
    const base = key === undefined ? undefined : this.deltaCache.get<R>(key);
    let response: R | undefined;
    if (key !== undefined && base !== undefined) {
      response = await this.refreshSnapshot(spec, key, base);
    }
    if (response === undefined) {
      await this.rateLimiter.acquire();
      response = await spec.fetch(undefined);
      const knowledge = response.data.server_knowledge;
      if (key !== undefined && isKnowledge(knowledge)) {
        this.storeSnapshot(spec, key, response, knowledge, this.deltaCache.now());
      }
    }

    this.recordKnowledge(spec, response);
    if (spec.ttlKey !== undefined && generation === this.cache.generation()) {
      this.cache.set(spec.ttlKey, response);
    }
    return response;
  }

  /** Step 2 of snapshotRead; undefined means "fall back to a full fetch". */
  private async refreshSnapshot<R extends KnowledgeResponse>(
    spec: SnapshotRead<R>,
    key: string,
    base: Snapshot<R>
  ): Promise<R | undefined> {
    let merged: R | undefined;
    try {
      merged = await spec.refresh(base.data, base.knowledge);
    } catch (error) {
      // Whatever went wrong, the next read starts over with a full fetch.
      this.deltaCache.delete(key, base);
      if (error instanceof DeltaMergeError) return undefined;
      throw error;
    }
    const knowledge = merged?.data.server_knowledge;
    if (merged === undefined || !isKnowledge(knowledge) || knowledge < base.knowledge) {
      this.deltaCache.delete(key, base);
      return undefined;
    }
    this.storeSnapshot(spec, key, merged, knowledge, base.baseFetchedAt, base);
    return merged;
  }

  /**
   * A caller-supplied cursor: return YNAB's delta for it as is (never cached).
   * When the store holds a snapshot whose knowledge is at or after the cursor,
   * the same delta also covers everything changed since the snapshot, so it is
   * merged in to keep the snapshot current at no extra request.
   */
  private async cursorRead<R extends KnowledgeResponse>(spec: SnapshotRead<R>, cursor: number): Promise<R> {
    await this.rateLimiter.acquire();
    const response = await spec.fetch(cursor);
    const knowledge = response.data.server_knowledge;
    const key = this.snapshotKey(spec);
    const merge = spec.merge;
    if (key !== undefined && merge !== undefined && isKnowledge(knowledge)) {
      const base = this.deltaCache.get<R>(key);
      if (base !== undefined && cursor <= base.knowledge && knowledge >= base.knowledge) {
        try {
          this.storeSnapshot(spec, key, merge(base.data, response), knowledge, base.baseFetchedAt, base);
        } catch (error) {
          if (!(error instanceof DeltaMergeError)) throw error;
          this.deltaCache.delete(key, base);
        }
      }
    }
    this.recordKnowledge(spec, response);
    return response;
  }

  private storeSnapshot<R extends KnowledgeResponse>(
    spec: SnapshotRead<R>,
    key: string,
    response: R,
    knowledge: number,
    baseFetchedAt: number,
    base?: Snapshot<R>
  ): void {
    const data = spec.copy(response);
    this.deltaCache.offer(key, { data, knowledge, entities: spec.size(data), baseFetchedAt }, base);
  }

  private recordKnowledge<R extends KnowledgeResponse>(spec: SnapshotRead<R>, response: R): void {
    const knowledge = response.data.server_knowledge;
    if (knowledge !== undefined) {
      this.updateServerKnowledge(spec.budgetId, knowledge, spec.resource, spec.params);
    }
  }

  /**
   * Drop TTL entries a write changes, bumping the generation so a read already
   * in flight (in any of the user's sessions) can't put its pre-write result
   * back. Called before the write, as before, and again once it has finished,
   * which also covers a read that started while the write was in flight.
   * Snapshots are left alone: the next read refreshes them with a delta.
   */
  private invalidateCached(...keys: string[]): void {
    this.cache.bumpGeneration();
    for (const key of keys) this.cache.delete(key);
  }

  /**
   * SnapshotRead fields for an endpoint without query filters (accounts,
   * categories, months, payees, scheduled transactions): its own delta is
   * complete, so a refresh is one delta request merged into the snapshot.
   */
  private endpointDelta<R extends KnowledgeResponse>(
    fetch: (lastKnowledgeOfServer: number | undefined) => Promise<R>,
    merge: (base: R, delta: R) => R
  ): Pick<SnapshotRead<R>, 'fetch' | 'refresh' | 'merge'> {
    return {
      fetch,
      merge,
      refresh: async (base, knowledge) => {
        await this.rateLimiter.acquire();
        const delta = await fetch(knowledge);
        return isKnowledge(delta.data.server_knowledge) ? merge(base, delta) : undefined;
      },
    };
  }

  /**
   * Every transaction in the budget changed since `knowledge` (deleted ones
   * with deleted: true): the budget-wide endpoint from the budget's first
   * month, with no other filter. Transaction snapshots are refreshed from this
   * rather than from their own endpoint's delta, because a filtered delta
   * (account, category, payee, type, dates) need not report a transaction that
   * changed so that it no longer matches (approved, re-categorized, re-dated),
   * which would leave it behind in the snapshot. Undefined when the first month
   * is unknown.
   */
  private async transactionChangeFeed(
    budgetId: string,
    knowledge: number
  ): Promise<{ firstMonth: string; transactions: ynab.TransactionDetail[]; knowledge: number } | undefined> {
    const firstMonth = await this.getBudgetFirstMonth(budgetId);
    if (firstMonth === undefined) return undefined;
    await this.rateLimiter.acquire();
    const delta = await this.api.transactions.getTransactions(budgetId, firstMonth, undefined, undefined, knowledge);
    const next = delta.data.server_knowledge;
    if (!isKnowledge(next) || !Array.isArray(delta.data.transactions)) return undefined;
    return { firstMonth, transactions: delta.data.transactions, knowledge: next };
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

  /** All accounts (TTL cached, delta refreshed; see snapshotRead). */
  async getAccounts(budgetId: string, options?: DeltaReadOptions): Promise<ynab.AccountsResponse> {
    return this.snapshotRead<ynab.AccountsResponse>({
      budgetId,
      resource: 'accounts',
      ttlKey: `accounts:${budgetId}`,
      cursor: options?.lastKnowledgeOfServer,
      ...this.endpointDelta(
        (knowledge) => this.api.accounts.getAccounts(budgetId, knowledge),
        (base, delta) => withData(delta, { accounts: mergeById(base.data.accounts, delta.data.accounts) })
      ),
      copy: (r) => withData(r, { accounts: r.data.accounts.slice() }),
      size: (r) => r.data.accounts.length,
    });
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
    // Only invalidate budgets:true since getBudgets(false) doesn't include account data
    this.invalidateCached(`accounts:${budgetId}`, 'budgets:true');

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
    } finally {
      this.invalidateCached(`accounts:${budgetId}`, 'budgets:true');
    }
  }

  // ==================== Categories ====================

  /** All category groups with their categories (TTL cached, delta refreshed). */
  async getCategories(budgetId: string, options?: DeltaReadOptions): Promise<ynab.CategoriesResponse> {
    return this.snapshotRead<ynab.CategoriesResponse>({
      budgetId,
      resource: 'categories',
      ttlKey: `categories:${budgetId}`,
      cursor: options?.lastKnowledgeOfServer,
      ...this.endpointDelta(
        (knowledge) => this.api.categories.getCategories(budgetId, knowledge),
        (base, delta) =>
          withData(delta, {
            category_groups: mergeCategoryGroups(base.data.category_groups, delta.data.category_groups),
          })
      ),
      copy: (r) =>
        withData(r, {
          category_groups: r.data.category_groups.map((g) => ({ ...g, categories: g.categories.slice() })),
        }),
      size: (r) => countCategoryEntities(r.data.category_groups),
    });
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
    this.invalidateCached(`categories:${budgetId}`);

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
    } finally {
      this.invalidateCached(`categories:${budgetId}`);
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
    this.invalidateCached(`categories:${budgetId}`);

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
    } finally {
      this.invalidateCached(`categories:${budgetId}`);
    }
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
    this.invalidateCached(`categories:${budgetId}`);

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
    } finally {
      this.invalidateCached(`categories:${budgetId}`);
    }
  }

  async createCategoryGroup(
    budgetId: string,
    data: ynab.PostCategoryGroupWrapper
  ): Promise<ynab.SaveCategoryGroupResponse> {
    this.assertWriteAllowed('createCategoryGroup');
    await this.rateLimiter.acquire();
    // Invalidate categories cache after creating (groups are returned with categories)
    this.invalidateCached(`categories:${budgetId}`);

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
    } finally {
      this.invalidateCached(`categories:${budgetId}`);
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
    this.invalidateCached(`categories:${budgetId}`);

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
    } finally {
      this.invalidateCached(`categories:${budgetId}`);
    }
  }

  // ==================== Transactions ====================

  /**
   * Budget transactions. Not TTL cached: every read asks YNAB, as a delta
   * against this query's snapshot when there is one (see snapshotRead).
   */
  async getTransactions(budgetId: string, options?: TransactionListOptions): Promise<ynab.TransactionsResponse> {
    return this.transactionListRead(budgetId, 'transactions', {}, options, (knowledge) =>
      this.api.transactions.getTransactions(
        budgetId,
        options?.sinceDate,
        options?.untilDate,
        options?.type,
        knowledge
      )
    );
  }

  /** Transactions for one plan month (YYYY-MM-01 or "current"). Not TTL cached, like getTransactions. */
  async getTransactionsByMonth(
    budgetId: string,
    month: string,
    options?: TransactionListOptions
  ): Promise<ynab.TransactionsResponse> {
    return this.transactionListRead(budgetId, 'transactions-by-month', { month }, options, (knowledge) =>
      this.api.transactions.getTransactionsByMonth(
        budgetId,
        month,
        options?.sinceDate,
        options?.untilDate,
        options?.type,
        knowledge
      )
    );
  }

  /**
   * Shared snapshotRead spec for the TransactionDetail list endpoints (budget,
   * month, account). The key holds the scope and every filter; queries without
   * since_date get YNAB's moving 12-month default, so their snapshots are per
   * UTC day, and "current" month (whose meaning moves too) is never kept.
   * Refreshes apply the budget's change feed through the query's local model
   * (see transactionQueryModel and transactionChangeFeed).
   */
  private transactionListRead(
    budgetId: string,
    resource: string,
    scope: { month?: string; id?: string },
    options: TransactionListOptions | undefined,
    fetch: (knowledge: number | undefined) => Promise<ynab.TransactionsResponse>
  ): Promise<ynab.TransactionsResponse> {
    const today = this.snapshotDay();
    const model = transactionQueryModel(
      {
        sinceDate: options?.sinceDate,
        untilDate: options?.untilDate,
        type: options?.type,
        month: scope.month,
        accountId: resource === 'account-transactions' ? scope.id : undefined,
      },
      today
    );
    return this.snapshotRead<ynab.TransactionsResponse>({
      budgetId,
      resource,
      params: { ...scope, sinceDate: options?.sinceDate, untilDate: options?.untilDate, type: options?.type },
      ...(options?.sinceDate === undefined ? { window: today } : {}),
      snapshot: scope.month === undefined || /^\d{4}-\d{2}-01$/.test(scope.month),
      cursor: options?.lastKnowledgeOfServer,
      fetch,
      refresh: async (base, knowledge) => {
        const feed = await this.transactionChangeFeed(budgetId, knowledge);
        if (feed === undefined) return undefined;
        const held = new Set<string>();
        for (const t of base.data.transactions) {
          // The feed starts at the first month; anything older means it isn't complete.
          if (t.date < feed.firstMonth) return undefined;
          held.add(t.id);
        }
        for (const t of feed.transactions) {
          if (t.deleted !== true && model.ambiguous(t) && (held.has(t.id) || model.core(t))) return undefined;
        }
        return withData(base, {
          transactions: mergeTransactions(base.data.transactions, feed.transactions, model.keep),
          server_knowledge: feed.knowledge,
        });
      },
      copy: (r) => withData(r, { transactions: r.data.transactions.slice() }),
      size: (r) => countTransactionEntities(r.data.transactions),
    });
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
    // Single-body requests use `transaction`; the skip-duplicates form uses a one-item `transactions`.
    const txn = data.transaction ?? data.transactions?.[0];
    // Count of split parts across the request (counts only; split memos/payees are never logged).
    const splitCount = [data.transaction, ...(data.transactions ?? [])].reduce(
      (n, t) => n + (t?.subtransactions?.length ?? 0),
      0
    );
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
          ...(splitCount > 0 ? { split_count: splitCount } : {}),
        },
        success: true,
      };
      const createdId = response.data.transaction?.id ?? response.data.transactions?.[0]?.id;
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
          ...(splitCount > 0 ? { split_count: splitCount } : {}),
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
    // Fields explicitly cleared with null (names only, never values).
    const clearedFields = (['category_id', 'payee_id', 'memo'] as const).filter(
      (f) => (txn[f] as string | null | undefined) === null
    );
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
          ...(clearedFields.length > 0 ? { cleared_fields: clearedFields } : {}),
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
          ...(clearedFields.length > 0 ? { cleared_fields: clearedFields } : {}),
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
    // Counts only: how many rows are addressed by import_id and how many fields are cleared with null.
    const byImportId = data.transactions.filter((t) => t.id === undefined && t.import_id != null).length;
    const clearedFieldCount = data.transactions.reduce(
      (n, t) =>
        n + (['category_id', 'payee_id', 'memo'] as const).filter((f) => (t[f] as string | null | undefined) === null).length,
      0
    );
    const extra = {
      ...(byImportId > 0 ? { addressed_by_import_id_count: byImportId } : {}),
      ...(clearedFieldCount > 0 ? { cleared_field_count: clearedFieldCount } : {}),
    };
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
          ...extra,
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
        details: { requested_count: data.transactions.length, ...extra },
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

  /** Transactions for one account. `type` filters to unapproved/uncategorized transactions. */
  async getAccountTransactions(
    budgetId: string,
    accountId: string,
    options?: ScopedTransactionOptions
  ): Promise<ynab.TransactionsResponse> {
    return this.transactionListRead(budgetId, 'account-transactions', { id: accountId }, options, (knowledge) =>
      this.api.transactions.getTransactionsByAccount(
        budgetId,
        accountId,
        options?.sinceDate,
        options?.untilDate,
        options?.type,
        knowledge
      )
    );
  }

  /** Transactions for one category. `type` filters to unapproved/uncategorized transactions. */
  async getCategoryTransactions(
    budgetId: string,
    categoryId: string,
    options?: ScopedTransactionOptions
  ): Promise<ynab.HybridTransactionsResponse> {
    return this.hybridListRead(budgetId, 'category-transactions', categoryId, options, (knowledge) =>
      this.api.transactions.getTransactionsByCategory(
        budgetId,
        categoryId,
        options?.sinceDate,
        options?.untilDate,
        options?.type,
        knowledge
      )
    );
  }

  /** Transactions for one payee. `type` filters to unapproved/uncategorized transactions. */
  async getPayeeTransactions(
    budgetId: string,
    payeeId: string,
    options?: ScopedTransactionOptions
  ): Promise<ynab.HybridTransactionsResponse> {
    return this.hybridListRead(budgetId, 'payee-transactions', payeeId, options, (knowledge) =>
      this.api.transactions.getTransactionsByPayee(
        budgetId,
        payeeId,
        options?.sinceDate,
        options?.untilDate,
        options?.type,
        knowledge
      )
    );
  }

  /**
   * snapshotRead spec for the HybridTransaction endpoints (category, payee),
   * where split lines are rows of their own. Keyed like transactionListRead,
   * with the scope id and every filter. A refresh reads the budget's change
   * feed: when no changed transaction touches this category/payee (by id, or by
   * its or a split line's category/payee) the snapshot is returned as is at the
   * new knowledge; otherwise the endpoint is re-read in full.
   */
  private hybridListRead(
    budgetId: string,
    resource: string,
    scopeId: string,
    options: ScopedTransactionOptions | undefined,
    fetch: (knowledge: number | undefined) => Promise<ynab.HybridTransactionsResponse>
  ): Promise<ynab.HybridTransactionsResponse> {
    const field = resource === 'category-transactions' ? 'category_id' : 'payee_id';
    return this.snapshotRead<ynab.HybridTransactionsResponse>({
      budgetId,
      resource,
      params: { id: scopeId, sinceDate: options?.sinceDate, untilDate: options?.untilDate, type: options?.type },
      ...(options?.sinceDate === undefined ? { window: this.snapshotDay() } : {}),
      cursor: options?.lastKnowledgeOfServer,
      fetch,
      refresh: async (base, knowledge) => {
        const feed = await this.transactionChangeFeed(budgetId, knowledge);
        if (feed === undefined) return undefined;
        const held = new Set<string>();
        for (const row of base.data.transactions) {
          held.add(row.id);
          if (row.parent_transaction_id) held.add(row.parent_transaction_id);
        }
        const touches = feed.transactions.some(
          (t) =>
            held.has(t.id) ||
            t[field] === scopeId ||
            (t.subtransactions ?? []).some((sub) => held.has(sub.id) || sub[field] === scopeId)
        );
        // Untouched: nothing in this category/payee changed, so the snapshot is
        // current as is. Touched: the rows a change produces here (split lines,
        // their names and amounts) are YNAB's to build, so re-read in full.
        return touches
          ? undefined
          : withData(base, { transactions: base.data.transactions.slice(), server_knowledge: feed.knowledge });
      },
      copy: (r) => withData(r, { transactions: r.data.transactions.slice() }),
      size: (r) => r.data.transactions.length,
    });
  }

  // ==================== Scheduled Transactions ====================

  /** All scheduled transactions. Not TTL cached; delta refreshed on every read. */
  async getScheduledTransactions(
    budgetId: string,
    options?: DeltaReadOptions
  ): Promise<ynab.ScheduledTransactionsResponse> {
    return this.snapshotRead<ynab.ScheduledTransactionsResponse>({
      budgetId,
      resource: 'scheduled-transactions',
      cursor: options?.lastKnowledgeOfServer,
      ...this.endpointDelta(
        (knowledge) => this.api.scheduledTransactions.getScheduledTransactions(budgetId, knowledge),
        (base, delta) =>
          withData(delta, {
            scheduled_transactions: mergeById(
              base.data.scheduled_transactions,
              delta.data.scheduled_transactions,
              { prepare: withoutDeletedSubtransactions }
            ),
          })
      ),
      copy: (r) => withData(r, { scheduled_transactions: r.data.scheduled_transactions.slice() }),
      size: (r) => countTransactionEntities(r.data.scheduled_transactions),
    });
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

  /** All payees (TTL cached, delta refreshed). */
  async getPayees(budgetId: string, options?: DeltaReadOptions): Promise<ynab.PayeesResponse> {
    return this.snapshotRead<ynab.PayeesResponse>({
      budgetId,
      resource: 'payees',
      ttlKey: `payees:${budgetId}`,
      cursor: options?.lastKnowledgeOfServer,
      ...this.endpointDelta(
        (knowledge) => this.api.payees.getPayees(budgetId, knowledge),
        (base, delta) => withData(delta, { payees: mergeById(base.data.payees, delta.data.payees) })
      ),
      copy: (r) => withData(r, { payees: r.data.payees.slice() }),
      size: (r) => r.data.payees.length,
    });
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
    this.invalidateCached(`payees:${budgetId}`);

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
    } finally {
      this.invalidateCached(`payees:${budgetId}`);
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
    this.invalidateCached(`payees:${budgetId}`);

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
    } finally {
      this.invalidateCached(`payees:${budgetId}`);
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

  /** All plan months. Not TTL cached; delta refreshed on every read. Months are keyed by `month`. */
  async getBudgetMonths(budgetId: string, options?: DeltaReadOptions): Promise<ynab.MonthSummariesResponse> {
    return this.snapshotRead<ynab.MonthSummariesResponse>({
      budgetId,
      resource: 'months',
      cursor: options?.lastKnowledgeOfServer,
      ...this.endpointDelta(
        (knowledge) => this.api.months.getPlanMonths(budgetId, knowledge),
        (base, delta) =>
          withData(delta, {
            months: orderLike(
              base.data.months,
              mergeBy(base.data.months, delta.data.months, (m) => m.month),
              (m) => m.month,
              delta.data.months
            ),
          })
      ),
      copy: (r) => withData(r, { months: r.data.months.slice() }),
      size: (r) => r.data.months.length,
    });
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

  async getMoneyMovementGroups(budgetId: string): Promise<ynab.MoneyMovementGroupsResponse> {
    await this.rateLimiter.acquire();
    return this.api.money_movements.getMoneyMovementGroups(budgetId);
  }

  async getMoneyMovementGroupsByMonth(
    budgetId: string,
    month: string
  ): Promise<ynab.MoneyMovementGroupsResponse> {
    await this.rateLimiter.acquire();
    return this.api.money_movements.getMoneyMovementGroupsByMonth(budgetId, month);
  }
}
