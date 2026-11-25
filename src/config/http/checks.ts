/**
 * Rules that span more than one topic, run after every loader on the composed
 * config. A rule that depends on a setting that failed to parse is skipped (the
 * parse problem is already listed), so one typo doesn't produce a second,
 * misleading message.
 */

import type { ConfigProblems } from '../parse.js';
import type { HttpConfig } from './index.js';
import { isLoopbackBind } from './server.js';
import { parseKeyring } from '../../crypto.js';

export type HttpCheck = (config: HttpConfig, problems: ConfigProblems) => void;

/** oauth mode serves many users, so a static YNAB token or budget would apply to all of them. */
const oauthRefusesStaticYnab: HttpCheck = (config, problems) => {
  if (config.authMode !== 'oauth' || problems.failed('AUTH_MODE')) return;
  if (config.fallbackAccessToken !== undefined) {
    problems.add('YNAB_ACCESS_TOKEN', 'YNAB_ACCESS_TOKEN must not be set when AUTH_MODE=oauth (each user connects their own YNAB account). Remove it.');
  }
  if (config.defaultBudgetId !== undefined) {
    problems.add('YNAB_BUDGET_ID', 'YNAB_BUDGET_ID must not be set when AUTH_MODE=oauth (it would apply to every user). Remove it.');
  }
};

/**
 * PUBLIC_URL is the OAuth issuer: http only for localhost and 127.0.0.1. The
 * SDK-era authorization server refused an http `[::1]` issuer; oidc-provider
 * accepts one, so this check is now our own rule, kept so a configuration
 * valid on 0.4.x stays the only kind accepted (#47-4).
 */
const oauthIssuerScheme: HttpCheck = (config, problems) => {
  if (config.authMode !== 'oauth' || problems.failed('AUTH_MODE') || problems.failed('PUBLIC_URL')) return;
  if (config.publicUrl === undefined) return;
  let url: URL;
  try {
    url = new URL(config.publicUrl);
  } catch {
    return;
  }
  if (url.protocol === 'http:' && url.hostname === '[::1]') {
    problems.add(
      'PUBLIC_URL',
      'Invalid PUBLIC_URL: OAuth mode needs https (http is allowed only for localhost or 127.0.0.1; [::1] is not accepted as an OAuth issuer).'
    );
  }
};

/**
 * Header mode with YNAB_ACCESS_TOKEN: a request without `X-YNAB-Token` acts as
 * the operator. On a bind other than loopback that is anyone who can reach the
 * port, so it takes an explicit opt-in.
 */
const headerFallbackNeedsLoopback: HttpCheck = (config, problems) => {
  if (config.authMode !== 'header' || problems.failed('AUTH_MODE')) return;
  if (config.fallbackAccessToken === undefined || config.allowAnonymousFallback) return;
  if (problems.failed('MCP_BIND_HOST')) return;
  if (!isLoopbackBind(config.bindHost)) {
    problems.add(
      'YNAB_ACCESS_TOKEN',
      'AUTH_MODE=header with YNAB_ACCESS_TOKEN lets any request without an X-YNAB-Token act as the operator, and the server is not bound to loopback. ' +
        'Bind to loopback (MCP_BIND_HOST=127.0.0.1), remove YNAB_ACCESS_TOKEN, or set MCP_ALLOW_ANONYMOUS_FALLBACK=true to accept this.'
    );
  }
};

/** oauth mode initializes storage at startup, so a driver's location setting is needed up front. */
const oauthStorageRequired: HttpCheck = (config, problems) => {
  if (config.authMode !== 'oauth' || problems.failed('AUTH_MODE') || problems.failed('STORAGE_DRIVER')) return;
  if (config.storageDriver === 'sqlite' && config.sqlitePath === undefined) {
    problems.add('SQLITE_PATH', 'STORAGE_DRIVER=sqlite requires SQLITE_PATH.');
  }
  if (config.storageDriver === 'postgres' && config.databaseUrl === undefined) {
    problems.add('DATABASE_URL', 'STORAGE_DRIVER=postgres requires DATABASE_URL.');
  }
};

/**
 * The keyring (#57b) must be consistent: no id twice, no key under two ids.
 * And a rotation needs TOKEN_PEPPER: without it the pepper is derived from
 * ENCRYPTION_KEY, so the new key would change it and the start be refused
 * (run `ynab-mcp derive-pepper` with the old key first).
 */
const oauthKeyring: HttpCheck = (config, problems) => {
  if (config.authMode !== 'oauth' || problems.failed('AUTH_MODE')) return;
  if (problems.failed('ENCRYPTION_KEY_ID') || problems.failed('ENCRYPTION_KEY_PREVIOUS')) return;
  if (config.encryptionKeyPrevious !== undefined && config.tokenPepper === undefined && !problems.failed('TOKEN_PEPPER')) {
    problems.add(
      'ENCRYPTION_KEY_PREVIOUS',
      'ENCRYPTION_KEY_PREVIOUS requires TOKEN_PEPPER: run `ynab-mcp derive-pepper` with the previous ENCRYPTION_KEY and set TOKEN_PEPPER to its output ' +
        '(see "Rotating ENCRYPTION_KEY" in docs/REMOTE_HOSTING.md).'
    );
  }
  // The ids can only clash when there are previous keys (ENCRYPTION_KEY's own
  // format is checked where the keyring is built, as before).
  if (config.encryptionKey === undefined || config.encryptionKeyPrevious === undefined) return;
  try {
    parseKeyring(config.encryptionKey, { keyId: config.encryptionKeyId, previousKeys: config.encryptionKeyPrevious });
  } catch (error) {
    // parseKeyring's messages name variables only, never a value.
    problems.add('ENCRYPTION_KEY', error instanceof Error ? error.message : 'Invalid ENCRYPTION_KEY.');
  }
};

/**
 * A refresh token's idle limit can't outlast its grant family's total limit
 * (#54b): an idle window longer than the TTL would never take effect, so it is
 * almost certainly a mistake.
 */
const refreshIdleWithinTtl: HttpCheck = (config, problems) => {
  if (problems.failed('MCP_REFRESH_TOKEN_IDLE_DAYS') || problems.failed('MCP_REFRESH_TOKEN_TTL_DAYS')) return;
  if (config.refreshTokenIdleDays > config.refreshTokenTtlDays) {
    problems.add(
      'MCP_REFRESH_TOKEN_IDLE_DAYS',
      'MCP_REFRESH_TOKEN_IDLE_DAYS must not exceed MCP_REFRESH_TOKEN_TTL_DAYS (a grant ends at the total limit however recently it was used).'
    );
  }
};

/**
 * RATE_LIMIT_STORE=postgres (#67, D-4) keeps the limits in the storage
 * database, so it needs the Postgres driver, which only oauth mode opens.
 * Refused, not ignored: an operator who asked for shared limits must not get
 * per-process ones silently.
 */
const rateLimitStoreNeedsPostgres: HttpCheck = (config, problems) => {
  if (config.rateLimitStore !== 'postgres' || problems.failed('RATE_LIMIT_STORE')) return;
  if (problems.failed('AUTH_MODE') || problems.failed('STORAGE_DRIVER')) return;
  if (config.authMode !== 'oauth' || config.storageDriver !== 'postgres') {
    problems.add(
      'RATE_LIMIT_STORE',
      'RATE_LIMIT_STORE=postgres requires AUTH_MODE=oauth and STORAGE_DRIVER=postgres (the limits are kept in that database). ' +
        'Use RATE_LIMIT_STORE=memory otherwise.'
    );
  }
};

/** Append-only: one line per rule. */
export const HTTP_CHECKS: readonly HttpCheck[] = [
  oauthRefusesStaticYnab,
  oauthIssuerScheme,
  headerFallbackNeedsLoopback,
  oauthStorageRequired,
  oauthKeyring,
  refreshIdleWithinTtl,
  rateLimitStoreNeedsPostgres,
];
