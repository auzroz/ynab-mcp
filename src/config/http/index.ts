/**
 * HTTP-mode configuration, composed from one loader per topic.
 *
 * To add settings, create `src/config/http/<topic>.ts` that exports an
 * interface and a `HttpLoader` (see types.ts), then add TWO lines here: its
 * import and its entry in LOADERS. HttpConfig is derived from the loaders'
 * return types, so no interface needs editing. A rule that spans topics goes
 * in checks.ts (one line in HTTP_CHECKS). Loaders record problems on
 * `problems` instead of throwing; `loadHttpConfig` throws one error listing
 * every problem, with no values in it.
 */

import { ConfigProblems, type Env } from '../parse.js';
import { HTTP_CHECKS } from './checks.js';
import { loadAuthSettings } from './auth.js';
import { loadRateLimitSettings } from './rate-limit.js';
import { loadSecurityTxtSettings } from './security-txt.js';
import { loadServerSettings } from './server.js';
import { loadSessionSettings } from './sessions.js';
import { loadStorageSettings } from './storage.js';
import { loadTokenSettings } from './tokens.js';
import { loadYnabSettings } from './ynab.js';
import { loadLimitSettings } from './limits.js';

export type { HttpAuthMode, AuthSettings } from './auth.js';
export type { RateLimitSettings } from './rate-limit.js';
export type { SecurityTxtSettings } from './security-txt.js';
export type { LogLevel, ServerSettings } from './server.js';
export type { SessionSettings } from './sessions.js';
export type { StorageDriver, StorageSettings } from './storage.js';
export type { TokenSettings } from './tokens.js';
export type { YnabSettings } from './ynab.js';
export type { LimitSettings } from './limits.js';

/** Append-only: one line per topic. */
const LOADERS = [
  loadServerSettings,
  loadSessionSettings,
  loadYnabSettings,
  loadAuthSettings,
  loadStorageSettings,
  loadTokenSettings,
  loadRateLimitSettings,
  loadSecurityTxtSettings,
  loadLimitSettings,
] as const;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Configuration for HTTP (remote / multi-tenant) mode: the intersection of every loader's slice. */
export type HttpConfig = UnionToIntersection<ReturnType<(typeof LOADERS)[number]>>;

export function loadHttpConfig(env: Env = process.env): HttpConfig {
  const problems = new ConfigProblems();
  const config = Object.assign({}, ...LOADERS.map((load) => load({ env, problems }))) as HttpConfig;
  for (const check of HTTP_CHECKS) check(config, problems);
  problems.throwIfAny();
  return config;
}
