/**
 * Retention windows of MCP grants and registrations (#54b):
 * `MCP_REFRESH_TOKEN_IDLE_DAYS`, `MCP_REFRESH_TOKEN_TTL_DAYS`,
 * `MCP_ABANDONED_CLIENT_HOURS` and `MCP_UNUSED_CLIENT_DAYS`.
 *
 * Unset or empty keeps the maintainer-approved default (src/auth/retention-defaults.ts).
 * Each is a whole number within its bounds (days up to {@link MAX_RETENTION_DAYS}); anything
 * else refuses to start. The idle window may not exceed the total window
 * (rule in checks.ts): a token could never reach an idle limit past its family's end.
 * Errors name the variable only, never its value.
 */

import { parseBoundedInteger } from '../parse.js';
import {
  ABANDONED_CLIENT_HOURS,
  MIN_ABANDONED_CLIENT_MS,
  REFRESH_TOKEN_IDLE_DAYS,
  REFRESH_TOKEN_TTL_DAYS,
  UNUSED_CLIENT_DAYS,
  retentionPolicy,
  type RetentionPolicy,
} from '../../auth/retention-defaults.js';
import type { HttpLoader } from './types.js';

/** Upper bound of every window given in days (ten years). */
export const MAX_RETENTION_DAYS = 3650;
/** The abandoned-registration window is in hours; the lower bound is the storage minimum (one hour). */
export const MIN_ABANDONED_CLIENT_HOURS = MIN_ABANDONED_CLIENT_MS / 3_600_000;
export const MAX_ABANDONED_CLIENT_HOURS = MAX_RETENTION_DAYS * 24;

export interface RetentionSettings {
  /** `MCP_REFRESH_TOKEN_IDLE_DAYS` (1-3650, default 30). */
  refreshTokenIdleDays: number;
  /** `MCP_REFRESH_TOKEN_TTL_DAYS` (1-3650, default 90). */
  refreshTokenTtlDays: number;
  /** `MCP_ABANDONED_CLIENT_HOURS` (1-87600, default 24). */
  abandonedClientHours: number;
  /** `MCP_UNUSED_CLIENT_DAYS` (1-3650, default 90). */
  unusedClientDays: number;
}

export const loadRetentionSettings: HttpLoader<RetentionSettings> = ({ env, problems }) => {
  const read = (name: string, fallback: number, min: number, max: number): number =>
    problems.capture(name, () => parseBoundedInteger(env[name], fallback, name, min, max), fallback);
  return {
    refreshTokenIdleDays: read('MCP_REFRESH_TOKEN_IDLE_DAYS', REFRESH_TOKEN_IDLE_DAYS, 1, MAX_RETENTION_DAYS),
    refreshTokenTtlDays: read('MCP_REFRESH_TOKEN_TTL_DAYS', REFRESH_TOKEN_TTL_DAYS, 1, MAX_RETENTION_DAYS),
    abandonedClientHours: read('MCP_ABANDONED_CLIENT_HOURS', ABANDONED_CLIENT_HOURS, MIN_ABANDONED_CLIENT_HOURS, MAX_ABANDONED_CLIENT_HOURS),
    unusedClientDays: read('MCP_UNUSED_CLIENT_DAYS', UNUSED_CLIENT_DAYS, 1, MAX_RETENTION_DAYS),
  };
};

/** The settings as the storage drivers' and the provider's {@link RetentionPolicy}. */
export function retentionPolicyFromSettings(settings: RetentionSettings): RetentionPolicy {
  const DAY = 24 * 3_600_000;
  return retentionPolicy({
    refreshTokenIdleMs: settings.refreshTokenIdleDays * DAY,
    refreshTokenTtlMs: settings.refreshTokenTtlDays * DAY,
    abandonedClientMs: settings.abandonedClientHours * 3_600_000,
    unusedClientMs: settings.unusedClientDays * DAY,
  });
}
