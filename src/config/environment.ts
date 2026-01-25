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

/**
 * Parse a boolean environment variable with strict validation.
 *
 * Accepts: 'true', '1', 'yes' => true
 *          'false', '0', 'no' => false
 *          undefined/empty => defaultValue
 *
 * Throws on unrecognized values to prevent security footguns
 * (e.g., YNAB_READ_ONLY=ture typo accidentally enabling writes).
 */
function parseBoolean(value: string | undefined, defaultValue: boolean, varName?: string): boolean {
  if (value === undefined || value === '') return defaultValue;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;

  const nameHint = varName ? ` for ${varName}` : '';
  throw new Error(
    `Invalid boolean value "${value}"${nameHint}. ` +
    `Expected: true, false, 1, 0, yes, or no.`
  );
}

/**
 * Parse an integer environment variable with strict validation.
 *
 * Rejects partial parses like "10ms" that parseInt would accept as 10.
 * Only accepts strings containing only digits.
 */
function parseInteger(value: string | undefined, defaultValue: number, varName?: string): number {
  if (value === undefined || value === '') return defaultValue;

  // Strict check: only digits allowed (no partial parses like "10ms" -> 10)
  if (!/^\d+$/.test(value)) {
    const nameHint = varName ? ` for ${varName}` : '';
    throw new Error(
      `Invalid integer value "${value}"${nameHint}. ` +
      `Expected a positive integer (digits only).`
    );
  }

  return Number(value);
}

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
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}
