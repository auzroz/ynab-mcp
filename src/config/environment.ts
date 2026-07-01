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

/** Split a comma/space-separated env list into a trimmed string array (or undefined). */
function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Configuration for HTTP (remote / multi-tenant) mode. The YNAB access token is
 * optional here: in multi-user deployments each request supplies its own token
 * (interim: via header; later: via OAuth), while single-user HTTP can still set
 * a fallback `YNAB_ACCESS_TOKEN`.
 */
/** Auth strategy for HTTP mode. */
export type HttpAuthMode = 'header' | 'oauth';

/** Persistence driver for the OAuth server. */
export type StorageDriver = 'memory' | 'sqlite' | 'postgres';

export interface HttpConfig {
  port: number;
  publicUrl: string | undefined;
  allowedHosts: string[] | undefined;
  allowedOrigins: string[] | undefined;
  enableDnsRebindingProtection: boolean;
  // Shared knobs, reused per user context.
  fallbackAccessToken: string | undefined;
  defaultBudgetId: string | undefined;
  readOnly: boolean;
  cacheTtlMs: number;
  rateLimitPerHour: number;

  // Auth mode: `oauth` when the YNAB OAuth app + encryption key + public URL are
  // all configured, otherwise the interim `header` mode.
  authMode: HttpAuthMode;
  oauthClientId: string | undefined;
  oauthClientSecret: string | undefined;
  encryptionKey: string | undefined;
  allowWrite: boolean;
  accessTokenTtlSec: number;
  authCodeTtlSec: number;

  // Storage (oauth mode)
  storageDriver: StorageDriver;
  sqlitePath: string | undefined;
  databaseUrl: string | undefined;
}

function parseStorageDriver(value: string | undefined): StorageDriver {
  const v = (value ?? 'memory').toLowerCase();
  if (v === 'memory' || v === 'sqlite' || v === 'postgres') return v;
  throw new Error(`Invalid STORAGE_DRIVER "${value}". Expected: memory, sqlite, or postgres.`);
}

export function loadHttpConfig(): HttpConfig {
  const allowedHosts = parseList(process.env['ALLOWED_HOSTS']);
  const allowedOrigins = parseList(process.env['ALLOWED_ORIGINS']);
  const publicUrl = process.env['PUBLIC_URL'] || undefined;
  const oauthClientId = process.env['YNAB_OAUTH_CLIENT_ID'] || undefined;
  const oauthClientSecret = process.env['YNAB_OAUTH_CLIENT_SECRET'] || undefined;
  const encryptionKey = process.env['ENCRYPTION_KEY'] || undefined;

  const oauthConfigured = Boolean(oauthClientId && oauthClientSecret && encryptionKey && publicUrl);

  return {
    port: parseInteger(process.env['PORT'], 3000, 'PORT'),
    publicUrl: publicUrl ? publicUrl.replace(/\/+$/, '') : undefined,
    allowedHosts,
    allowedOrigins,
    // Only meaningful when a host/origin allowlist is configured.
    enableDnsRebindingProtection:
      parseBoolean(process.env['ENABLE_DNS_REBINDING_PROTECTION'], false, 'ENABLE_DNS_REBINDING_PROTECTION') &&
      (allowedHosts !== undefined || allowedOrigins !== undefined),
    fallbackAccessToken: process.env['YNAB_ACCESS_TOKEN'] || undefined,
    defaultBudgetId: process.env['YNAB_BUDGET_ID'] || undefined,
    readOnly: parseBoolean(process.env['YNAB_READ_ONLY'], true, 'YNAB_READ_ONLY'),
    cacheTtlMs: parseInteger(process.env['CACHE_TTL_MS'], 300000, 'CACHE_TTL_MS'),
    rateLimitPerHour: parseInteger(process.env['RATE_LIMIT_PER_HOUR'], 180, 'RATE_LIMIT_PER_HOUR'),

    authMode: oauthConfigured ? 'oauth' : 'header',
    oauthClientId,
    oauthClientSecret,
    encryptionKey,
    allowWrite: parseBoolean(process.env['YNAB_OAUTH_ALLOW_WRITE'], true, 'YNAB_OAUTH_ALLOW_WRITE'),
    accessTokenTtlSec: parseInteger(process.env['MCP_ACCESS_TOKEN_TTL_SEC'], 3600, 'MCP_ACCESS_TOKEN_TTL_SEC'),
    authCodeTtlSec: parseInteger(process.env['MCP_AUTH_CODE_TTL_SEC'], 600, 'MCP_AUTH_CODE_TTL_SEC'),

    storageDriver: parseStorageDriver(process.env['STORAGE_DRIVER']),
    sqlitePath: process.env['SQLITE_PATH'] || undefined,
    databaseUrl: process.env['DATABASE_URL'] || undefined,
  };
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
