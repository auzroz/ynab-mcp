/**
 * Rules that span more than one topic, run after every loader on the composed
 * config. A rule that depends on a setting that failed to parse is skipped (the
 * parse problem is already listed), so one typo doesn't produce a second,
 * misleading message.
 */

import type { ConfigProblems } from '../parse.js';
import type { HttpConfig } from './index.js';
import { isLoopbackBind } from './server.js';

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

/** PUBLIC_URL is the OAuth issuer, and the MCP SDK accepts an http issuer only for localhost and 127.0.0.1. */
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

/** Append-only: one line per rule. */
export const HTTP_CHECKS: readonly HttpCheck[] = [
  oauthRefusesStaticYnab,
  oauthIssuerScheme,
  headerFallbackNeedsLoopback,
];
