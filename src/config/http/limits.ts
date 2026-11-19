/**
 * Stateless /mcp limits (ADR-0001 D6, D8): the in-flight caps, the request
 * ceiling, and which of the retired session settings are still set.
 *
 *  - `MCP_MAX_INFLIGHT_PER_USER` (1-64, default 8): requests in flight per user.
 *  - `MCP_MAX_INFLIGHT_PER_CLIENT` (1-64, default 4): per (client, user); oauth
 *    mode only, header mode has no client identity. Must not exceed the per-user cap.
 *  - `MCP_MAX_INFLIGHT` (1-1024, default 64): across the process. Must not be
 *    below the per-user cap.
 *  - `MCP_REQUEST_TIMEOUT_MS` (5000-300000, default 60000): the request ceiling.
 *
 * A default follows a smaller explicit cap (as MCP_MAX_SESSIONS_PER_USER's did),
 * so lowering one cap never makes another one's default invalid. Errors name the
 * variable and its range, never its value.
 *
 * `MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_USER` and
 * `MCP_SESSION_IDLE_TIMEOUT_MS` are still parsed strictly (sessions.ts) but have
 * no effect; `deprecatedSessionSettings` lists the ones that are set, for the
 * one-time startup warning. 0.6 removes them.
 */

import { parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

export const INFLIGHT_PER_USER_DEFAULT = 8;
export const INFLIGHT_PER_CLIENT_DEFAULT = 4;
export const INFLIGHT_TOTAL_DEFAULT = 64;
export const REQUEST_TIMEOUT_DEFAULT_MS = 60_000;

/** Retired with sessions (ADR-0001 D8): parsed, ignored, warned about once. */
export const DEPRECATED_SESSION_SETTINGS = [
  'MCP_MAX_SESSIONS',
  'MCP_MAX_SESSIONS_PER_USER',
  'MCP_SESSION_IDLE_TIMEOUT_MS',
] as const;

export interface LimitSettings {
  /** `MCP_MAX_INFLIGHT_PER_USER`. */
  maxInflightPerUser: number;
  /** `MCP_MAX_INFLIGHT_PER_CLIENT` (per client and user; oauth mode). */
  maxInflightPerClient: number;
  /** `MCP_MAX_INFLIGHT`, across the process. */
  maxInflight: number;
  /** `MCP_REQUEST_TIMEOUT_MS`: the /mcp request ceiling. */
  requestTimeoutMs: number;
  /** The retired session settings that are set (non-empty), in DEPRECATED_SESSION_SETTINGS order. */
  deprecatedSessionSettings: readonly string[];
}

/** The one-time startup warning for the retired session settings that are set; undefined when none is. */
export function deprecatedSessionSettingsWarning(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return (
    `WARNING: ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no effect: /mcp is stateless since 0.5.0, ` +
    'and these settings will be removed in 0.6. Use MCP_MAX_INFLIGHT_PER_USER, MCP_MAX_INFLIGHT_PER_CLIENT, ' +
    'MCP_MAX_INFLIGHT and MCP_REQUEST_TIMEOUT_MS instead.'
  );
}

export const loadLimitSettings: HttpLoader<LimitSettings> = ({ env, problems }) => {
  const isSet = (name: string): boolean => env[name] !== undefined && env[name] !== '';

  const maxInflight = problems.capture(
    'MCP_MAX_INFLIGHT',
    () => parseBoundedInteger(env['MCP_MAX_INFLIGHT'], INFLIGHT_TOTAL_DEFAULT, 'MCP_MAX_INFLIGHT', 1, 1024),
    INFLIGHT_TOTAL_DEFAULT
  );
  const perUserDefault = Math.min(INFLIGHT_PER_USER_DEFAULT, maxInflight);
  const maxInflightPerUser = problems.capture(
    'MCP_MAX_INFLIGHT_PER_USER',
    () => parseBoundedInteger(env['MCP_MAX_INFLIGHT_PER_USER'], perUserDefault, 'MCP_MAX_INFLIGHT_PER_USER', 1, 64),
    perUserDefault
  );
  if (
    isSet('MCP_MAX_INFLIGHT_PER_USER') &&
    maxInflightPerUser > maxInflight &&
    !problems.failed('MCP_MAX_INFLIGHT_PER_USER') &&
    !problems.failed('MCP_MAX_INFLIGHT')
  ) {
    problems.add('MCP_MAX_INFLIGHT_PER_USER', 'Invalid MCP_MAX_INFLIGHT_PER_USER: must not exceed MCP_MAX_INFLIGHT.');
  }
  const perClientDefault = Math.min(INFLIGHT_PER_CLIENT_DEFAULT, maxInflightPerUser);
  const maxInflightPerClient = problems.capture(
    'MCP_MAX_INFLIGHT_PER_CLIENT',
    () =>
      parseBoundedInteger(env['MCP_MAX_INFLIGHT_PER_CLIENT'], perClientDefault, 'MCP_MAX_INFLIGHT_PER_CLIENT', 1, 64),
    perClientDefault
  );
  if (
    isSet('MCP_MAX_INFLIGHT_PER_CLIENT') &&
    maxInflightPerClient > maxInflightPerUser &&
    !problems.failed('MCP_MAX_INFLIGHT_PER_CLIENT') &&
    !problems.failed('MCP_MAX_INFLIGHT_PER_USER')
  ) {
    problems.add(
      'MCP_MAX_INFLIGHT_PER_CLIENT',
      'Invalid MCP_MAX_INFLIGHT_PER_CLIENT: must not exceed MCP_MAX_INFLIGHT_PER_USER.'
    );
  }

  return {
    maxInflightPerUser,
    maxInflightPerClient,
    maxInflight,
    requestTimeoutMs: problems.capture(
      'MCP_REQUEST_TIMEOUT_MS',
      () =>
        parseBoundedInteger(env['MCP_REQUEST_TIMEOUT_MS'], REQUEST_TIMEOUT_DEFAULT_MS, 'MCP_REQUEST_TIMEOUT_MS', 5000, 300_000),
      REQUEST_TIMEOUT_DEFAULT_MS
    ),
    deprecatedSessionSettings: DEPRECATED_SESSION_SETTINGS.filter(isSet),
  };
};
