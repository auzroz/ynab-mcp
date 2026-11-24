/**
 * The inactive-user erase (#54e, D-5): `MCP_INACTIVE_USER_DAYS`.
 *
 * Off by default (unset or empty). When set, it must be a whole number of
 * days from {@link MIN_INACTIVE_USER_DAYS} to {@link MAX_INACTIVE_USER_DAYS}:
 * a user not seen for that long (no sign-in, re-consent or YNAB refresh) and
 * with no live grant is erased (src/auth/inactive-user-job.ts). Anything else,
 * `0` included, refuses to start.
 */

import { parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

export const MIN_INACTIVE_USER_DAYS = 30;
export const MAX_INACTIVE_USER_DAYS = 3650;

export interface InactiveUserSettings {
  /** `MCP_INACTIVE_USER_DAYS`; undefined when the erase is off. */
  inactiveUserDays: number | undefined;
}

export const loadInactiveUserSettings: HttpLoader<InactiveUserSettings> = ({ env, problems }) => {
  const raw = env['MCP_INACTIVE_USER_DAYS'];
  if (raw === undefined || raw === '') return { inactiveUserDays: undefined };
  return {
    inactiveUserDays: problems.capture(
      'MCP_INACTIVE_USER_DAYS',
      () =>
        parseBoundedInteger(raw, MIN_INACTIVE_USER_DAYS, 'MCP_INACTIVE_USER_DAYS', MIN_INACTIVE_USER_DAYS, MAX_INACTIVE_USER_DAYS),
      undefined
    ),
  };
};
