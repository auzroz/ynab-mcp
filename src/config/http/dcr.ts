/**
 * Client registration policy (#55): `MCP_DCR_PRIVATE_USE_SCHEMES`, the
 * private-use schemes (RFC 8252 section 7.1) a registration may use for a
 * native app's redirect URI, such as `com.example.app`. Default: none.
 *
 * Errors name the variable only, never its value.
 */

import { parseList } from '../parse.js';
import type { HttpLoader } from './types.js';

export interface DcrSettings {
  /** `MCP_DCR_PRIVATE_USE_SCHEMES`, lowercase, without the trailing colon. */
  privateUseSchemes: readonly string[];
}

/** Batch-3 default (#55): no private-use scheme is accepted until an operator lists one. */
export const DEFAULT_PRIVATE_USE_SCHEMES: readonly string[] = [];

/** The longest redirect URI a registration may hold. */
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
  privateUseSchemes: problems.capture(
    'MCP_DCR_PRIVATE_USE_SCHEMES',
    () => parsePrivateUseSchemes(env['MCP_DCR_PRIVATE_USE_SCHEMES']),
    []
  ),
});
