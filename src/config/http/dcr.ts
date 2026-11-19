/**
 * Client registration and authorization-request policy (#55):
 * `MCP_VERIFIED_REDIRECT_URIS`, `MCP_DCR_PRIVATE_USE_SCHEMES` and
 * `MCP_TRUST_LOOPBACK_REDIRECTS`.
 *
 * - **Verified redirect URIs.** An authorization error is redirected back to
 *   the client (RFC 6749 section 4.1.2.1) only when the request's redirect URI
 *   is on this list (or is loopback, see below). For any other client the error
 *   is shown on this server's own page, with a "Return to <host>" link, so the
 *   server can't be used as an open redirector. The consent page names a
 *   verified client plainly and any other as "calls itself ...". Default: the
 *   claude.ai connector callbacks. `none` empties the list (every error then
 *   renders here).
 * - **Private-use schemes** (RFC 8252 section 7.1) a registration may use for
 *   a native app's redirect URI, such as `com.example.app`. Default: none.
 * - **Loopback redirects** (`http://localhost`, `127.0.0.1`, `[::1]`): trusted
 *   for error redirects by default, since they can only reach the user's own
 *   device. The consent page still labels them.
 *
 * Errors name the variable only, never its value.
 */

import { parseAbsoluteUrl, parseBoolean, parseList } from '../parse.js';
import type { HttpLoader } from './types.js';

export interface DcrSettings {
  /** `MCP_VERIFIED_REDIRECT_URIS`, each normalized to its URL `href`. */
  verifiedRedirectUris: readonly string[];
  /** `MCP_DCR_PRIVATE_USE_SCHEMES`, lowercase, without the trailing colon. */
  privateUseSchemes: readonly string[];
  /** `MCP_TRUST_LOOPBACK_REDIRECTS`: loopback redirect URIs receive error redirects. */
  trustLoopbackRedirects: boolean;
}

/**
 * Batch-3 default (#55): Claude's connector callback, at both of the hosts its
 * documentation lists ("allowlist both if you restrict callback URLs").
 */
export const DEFAULT_VERIFIED_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

/** Batch-3 default (#55): no private-use scheme is accepted until an operator lists one. */
export const DEFAULT_PRIVATE_USE_SCHEMES: readonly string[] = [];

/** Batch-3 default (#55): loopback redirect URIs are trusted for error redirects. */
export const DEFAULT_TRUST_LOOPBACK_REDIRECTS = true;

/** The longest redirect URI a registration (or the verified list) may hold. */
export const MAX_REDIRECT_URI_LENGTH = 512;

const MAX_LIST_ENTRIES = 20;

/**
 * Schemes that are never a native app's private-use scheme: the web's own,
 * and the ones a browser runs or reads locally.
 */
const RESERVED_SCHEMES: ReadonlySet<string> = new Set([
  'http', 'https', 'ws', 'wss', 'ftp', 'file', 'data', 'blob', 'about', 'javascript', 'vbscript',
  'filesystem', 'view-source', 'mailto', 'tel', 'sms', 'intent',
]);

/** An explicit empty list, as opposed to unset (the default). */
const NONE = 'none';

/** Parse `MCP_VERIFIED_REDIRECT_URIS`: undefined keeps the default; `none` is an empty list. */
export function parseVerifiedRedirectUris(raw: string | undefined): readonly string[] {
  if (raw !== undefined && raw.trim().toLowerCase() === NONE) return [];
  const items = parseList(raw);
  if (items === undefined) return DEFAULT_VERIFIED_REDIRECT_URIS;
  if (items.length > MAX_LIST_ENTRIES) {
    throw new Error(`Invalid MCP_VERIFIED_REDIRECT_URIS: at most ${MAX_LIST_ENTRIES} entries.`);
  }
  return [
    ...new Set(
      items.map((item) => {
        if (item.length > MAX_REDIRECT_URI_LENGTH) {
          throw new Error(`Invalid MCP_VERIFIED_REDIRECT_URIS: each entry must be at most ${MAX_REDIRECT_URI_LENGTH} characters.`);
        }
        const url = parseAbsoluteUrl(item, 'MCP_VERIFIED_REDIRECT_URIS');
        if (url.username !== '' || url.password !== '') {
          throw new Error('Invalid MCP_VERIFIED_REDIRECT_URIS: an entry must not contain userinfo.');
        }
        return url.href;
      })
    ),
  ];
}

/** Parse `MCP_DCR_PRIVATE_USE_SCHEMES`: scheme names (`com.example.app` or `com.example.app:`). */
export function parsePrivateUseSchemes(raw: string | undefined): readonly string[] {
  if (raw !== undefined && raw.trim().toLowerCase() === NONE) return [];
  const items = parseList(raw);
  if (items === undefined) return DEFAULT_PRIVATE_USE_SCHEMES;
  if (items.length > MAX_LIST_ENTRIES) {
    throw new Error(`Invalid MCP_DCR_PRIVATE_USE_SCHEMES: at most ${MAX_LIST_ENTRIES} entries.`);
  }
  return [
    ...new Set(
      items.map((item) => {
        const scheme = item.toLowerCase().replace(/:$/, '');
        if (!/^[a-z][a-z0-9+.-]{0,63}$/.test(scheme)) {
          throw new Error('Invalid MCP_DCR_PRIVATE_USE_SCHEMES: each entry must be a URI scheme name, such as com.example.app.');
        }
        if (RESERVED_SCHEMES.has(scheme)) {
          throw new Error('Invalid MCP_DCR_PRIVATE_USE_SCHEMES: http, https and browser schemes are not private-use schemes.');
        }
        return scheme;
      })
    ),
  ];
}

/** Whether `scheme` (lowercase, no colon) can never be a private-use scheme. */
export function isReservedScheme(scheme: string): boolean {
  return RESERVED_SCHEMES.has(scheme);
}

export const loadDcrSettings: HttpLoader<DcrSettings> = ({ env, problems }) => ({
  verifiedRedirectUris: problems.capture(
    'MCP_VERIFIED_REDIRECT_URIS',
    () => parseVerifiedRedirectUris(env['MCP_VERIFIED_REDIRECT_URIS']),
    // On a bad value the list is empty: every error renders here (fail closed).
    []
  ),
  privateUseSchemes: problems.capture(
    'MCP_DCR_PRIVATE_USE_SCHEMES',
    () => parsePrivateUseSchemes(env['MCP_DCR_PRIVATE_USE_SCHEMES']),
    []
  ),
  trustLoopbackRedirects: problems.capture(
    'MCP_TRUST_LOOPBACK_REDIRECTS',
    () => parseBoolean(env['MCP_TRUST_LOOPBACK_REDIRECTS'], DEFAULT_TRUST_LOOPBACK_REDIRECTS, 'MCP_TRUST_LOOPBACK_REDIRECTS'),
    false
  ),
});
