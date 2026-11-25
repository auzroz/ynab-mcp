/**
 * Where the rate limits live, and how many replicas the operator runs (#67a,
 * maintainer decision D-4).
 *
 *  - `RATE_LIMIT_STORE`: `memory` (default) keeps every limit in this process;
 *    `postgres` shares the per-user YNAB request budget, the authorization
 *    server's limiters and the metadata-document fetch budget through the
 *    database (#67b, #67c). Exactly `memory` or `postgres`; `postgres` needs
 *    AUTH_MODE=oauth and STORAGE_DRIVER=postgres (checks.ts). Opt-in: nothing
 *    turns it on by itself.
 *  - `MCP_REPLICAS` (1-1000, default 1): the replicas serving this deployment.
 *    It changes nothing but the startup warning: more than one with
 *    `RATE_LIMIT_STORE=memory` gives each user a budget per replica.
 *
 * Errors name the variable only, never its value.
 */

import { parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

export type RateLimitStore = 'memory' | 'postgres';

export const MCP_REPLICAS_MAX = 1000;

export interface RateLimitStoreSettings {
  /** `RATE_LIMIT_STORE`. */
  rateLimitStore: RateLimitStore;
  /** `MCP_REPLICAS`: declared replicas; only the startup warning reads it. */
  mcpReplicas: number;
}

/** Strict: unset or empty is `memory`; anything but `memory` or `postgres` is refused. */
export function parseRateLimitStore(value: string | undefined): RateLimitStore {
  if (value === undefined || value === '') return 'memory';
  if (value === 'memory' || value === 'postgres') return value;
  throw new Error('Invalid RATE_LIMIT_STORE. Expected: memory or postgres.');
}

/**
 * The startup warning for several replicas on per-process limits; undefined
 * when there is nothing to warn about.
 */
export function replicaRateLimitWarning(settings: RateLimitStoreSettings): string | undefined {
  if (settings.mcpReplicas <= 1 || settings.rateLimitStore !== 'memory') return undefined;
  return (
    `WARNING: MCP_REPLICAS=${settings.mcpReplicas} but RATE_LIMIT_STORE=memory: each replica keeps its own rate limits, ` +
    `so a user can spend up to ${settings.mcpReplicas} times RATE_LIMIT_PER_HOUR YNAB requests an hour (YNAB allows 200) ` +
    'and every authorization-server limit is multiplied the same way. Set RATE_LIMIT_STORE=postgres ' +
    '(with STORAGE_DRIVER=postgres) to share them; see "Several replicas: shared rate limits" in docs/REMOTE_HOSTING.md.'
  );
}

export const loadRateLimitStoreSettings: HttpLoader<RateLimitStoreSettings> = ({ env, problems }) => ({
  rateLimitStore: problems.capture('RATE_LIMIT_STORE', () => parseRateLimitStore(env['RATE_LIMIT_STORE']), 'memory'),
  mcpReplicas: problems.capture(
    'MCP_REPLICAS',
    () => parseBoundedInteger(env['MCP_REPLICAS'], 1, 'MCP_REPLICAS', 1, MCP_REPLICAS_MAX),
    1
  ),
});
