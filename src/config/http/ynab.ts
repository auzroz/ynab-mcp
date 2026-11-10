/** What every user context shares: the YNAB token fallback, budget, read-only flag, cache and request budget. */

import { parseBoolean, parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

export interface YnabSettings {
  /** `YNAB_ACCESS_TOKEN`: header mode's token for requests without an `X-YNAB-Token`. Refused in oauth mode. */
  fallbackAccessToken: string | undefined;
  /** `YNAB_BUDGET_ID`: applies to every user. Refused in oauth mode. */
  defaultBudgetId: string | undefined;
  readOnly: boolean;
  cacheTtlMs: number;
  /** YNAB requests per user per hour (1-195; YNAB's own limit is 200). */
  rateLimitPerHour: number;
}

export const loadYnabSettings: HttpLoader<YnabSettings> = ({ env, problems }) => ({
  fallbackAccessToken: env['YNAB_ACCESS_TOKEN'] || undefined,
  defaultBudgetId: env['YNAB_BUDGET_ID'] || undefined,
  readOnly: problems.capture('YNAB_READ_ONLY', () => parseBoolean(env['YNAB_READ_ONLY'], true, 'YNAB_READ_ONLY'), true),
  cacheTtlMs: problems.capture(
    'CACHE_TTL_MS', () => parseBoundedInteger(env['CACHE_TTL_MS'], 300000, 'CACHE_TTL_MS', 1, 24 * 3600 * 1000), 300000),
  rateLimitPerHour: problems.capture(
    'RATE_LIMIT_PER_HOUR', () => parseBoundedInteger(env['RATE_LIMIT_PER_HOUR'], 180, 'RATE_LIMIT_PER_HOUR', 1, 195), 180),
});
