/**
 * Environment Configuration
 * 
 * Loads and validates configuration from environment variables.
 */

import { z } from 'zod';

const configSchema = z.object({
  accessToken: z.string().min(1, 'YNAB_ACCESS_TOKEN is required'),
  defaultBudgetId: z.union([z.string().uuid(), z.literal('last-used')]).optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  cacheTtlMs: z.number().int().positive().default(300000), // 5 minutes
  rateLimitPerHour: z.number().int().min(1).max(200).default(180),
  readOnly: z.boolean().default(true), // Safety: read-only by default
});

export type Config = z.infer<typeof configSchema>;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  const lower = value.toLowerCase();
  return lower === 'true' || lower === '1' || lower === 'yes';
}

export function loadConfig(): Config {
  const rawConfig = {
    accessToken: process.env['YNAB_ACCESS_TOKEN'] ?? '',
    defaultBudgetId: process.env['YNAB_BUDGET_ID'] || undefined,
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    cacheTtlMs: process.env['CACHE_TTL_MS']
      ? parseInt(process.env['CACHE_TTL_MS'], 10)
      : 300000,
    rateLimitPerHour: process.env['RATE_LIMIT_PER_HOUR']
      ? parseInt(process.env['RATE_LIMIT_PER_HOUR'], 10)
      : 180,
    // READ_ONLY defaults to true for safety - must explicitly set to false to enable writes
    readOnly: parseBoolean(process.env['YNAB_READ_ONLY'], true),
  };

  const result = configSchema.safeParse(rawConfig);
  
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}
