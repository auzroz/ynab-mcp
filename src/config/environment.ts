/**
 * Environment Configuration
 *
 * Stdio-mode configuration lives here. HTTP mode is configured by the loaders
 * in ./http/ (one file per topic, composed by `loadHttpConfig`).
 */

import { z } from 'zod';
import { budgetIdSentinel, ynabId } from '../utils/schemas.js';
import { parseBoolean, parseInteger } from './parse.js';

export { loadHttpConfig } from './http/index.js';
export type { HttpConfig, HttpAuthMode, StorageDriver } from './http/index.js';

const configSchema = z.object({
  accessToken: z.string().min(1, 'YNAB_ACCESS_TOKEN is required'),
  defaultBudgetId: z.union([ynabId(), budgetIdSentinel()]).optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  cacheTtlMs: z.number().int().positive().default(300000), // 5 minutes
  rateLimitPerHour: z.number().int().min(1).max(200).default(180),
  readOnly: z.boolean().default(true), // Safety: read-only by default
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const rawConfig = {
    accessToken: process.env['YNAB_ACCESS_TOKEN'] ?? '',
    defaultBudgetId: process.env['YNAB_BUDGET_ID'] || undefined,
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    cacheTtlMs: parseInteger(process.env['CACHE_TTL_MS'], 300000, 'CACHE_TTL_MS'),
    rateLimitPerHour: parseInteger(process.env['RATE_LIMIT_PER_HOUR'], 180, 'RATE_LIMIT_PER_HOUR'),
    // READ_ONLY defaults to true for safety - must explicitly set to false to enable writes
    readOnly: parseBoolean(process.env['YNAB_READ_ONLY'], true, 'YNAB_READ_ONLY'),
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}
