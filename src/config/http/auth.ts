/** Auth mode, the YNAB OAuth app, the write policy and the MCP token lifetimes. */

import { parseBoolean, parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

/** Auth strategy for HTTP mode. */
export type HttpAuthMode = 'header' | 'oauth';

export interface AuthSettings {
  /** `AUTH_MODE`: required in HTTP mode. */
  authMode: HttpAuthMode;
  oauthClientId: string | undefined;
  oauthClientSecret: string | undefined;
  encryptionKey: string | undefined;
  /**
   * `YNAB_OAUTH_ALLOW_WRITE` (default false). Enforced on every request, not
   * only at consent: unless true, no connection can write, whatever scope it
   * was granted.
   */
  allowWrite: boolean;
  /**
   * `MCP_ALLOW_ANONYMOUS_FALLBACK`: in header mode, lets requests without an
   * `X-YNAB-Token` use `YNAB_ACCESS_TOKEN` on a non-loopback bind.
   */
  allowAnonymousFallback: boolean;
  accessTokenTtlSec: number;
  authCodeTtlSec: number;
}

/** The variables oauth mode needs, in the order the error lists them. */
export const OAUTH_REQUIRED_VARS = ['YNAB_OAUTH_CLIENT_ID', 'YNAB_OAUTH_CLIENT_SECRET', 'ENCRYPTION_KEY', 'PUBLIC_URL'] as const;

export const loadAuthSettings: HttpLoader<AuthSettings> = ({ env, problems }) => {
  const modeRaw = env['AUTH_MODE'];
  const authMode = problems.capture<HttpAuthMode>(
    'AUTH_MODE',
    () => {
      const v = modeRaw?.trim().toLowerCase();
      if (v === 'oauth' || v === 'header') return v;
      throw new Error(
        modeRaw === undefined || modeRaw === ''
          ? 'AUTH_MODE is required in HTTP mode. Set it to oauth or header.'
          : 'Invalid value for AUTH_MODE. Expected: oauth or header.'
      );
    },
    'header'
  );

  if (authMode === 'oauth' && !problems.failed('AUTH_MODE')) {
    const missing = OAUTH_REQUIRED_VARS.filter((name) => !env[name]);
    if (missing.length > 0) {
      // Its own key, so the other oauth-mode rules (a static token) still run and are listed too.
      problems.add('OAUTH_VARIABLES', `AUTH_MODE=oauth also requires ${missing.join(', ')}.`);
    }
  }

  // Literal names (not a variable): the site test reads env names from the source.
  const allowWrite = problems.capture(
    'YNAB_OAUTH_ALLOW_WRITE', () => parseBoolean(env['YNAB_OAUTH_ALLOW_WRITE'], false, 'YNAB_OAUTH_ALLOW_WRITE'), false);
  const allowAnonymousFallback = problems.capture(
    'MCP_ALLOW_ANONYMOUS_FALLBACK',
    () => parseBoolean(env['MCP_ALLOW_ANONYMOUS_FALLBACK'], false, 'MCP_ALLOW_ANONYMOUS_FALLBACK'),
    false
  );

  return {
    authMode,
    oauthClientId: env['YNAB_OAUTH_CLIENT_ID'] || undefined,
    oauthClientSecret: env['YNAB_OAUTH_CLIENT_SECRET'] || undefined,
    encryptionKey: env['ENCRYPTION_KEY'] || undefined,
    allowWrite,
    allowAnonymousFallback,
    accessTokenTtlSec: problems.capture(
      'MCP_ACCESS_TOKEN_TTL_SEC',
      () => parseBoundedInteger(env['MCP_ACCESS_TOKEN_TTL_SEC'], 3600, 'MCP_ACCESS_TOKEN_TTL_SEC', 60, 3600), 3600),
    authCodeTtlSec: problems.capture(
      'MCP_AUTH_CODE_TTL_SEC',
      () => parseBoundedInteger(env['MCP_AUTH_CODE_TTL_SEC'], 600, 'MCP_AUTH_CODE_TTL_SEC', 30, 600), 600),
  };
};
