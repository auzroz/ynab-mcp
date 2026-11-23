/**
 * YNAB_WRITE_LIMIT_PER_HOUR: how many write requests one user may make per
 * hour (#61c, D-8). One write request is one write tool call, so a bulk call
 * counts as 1. 0 disables the cap. Applies on every transport.
 */

import { parseBoundedInteger } from './parse.js';

export const WRITE_LIMIT_DEFAULT_PER_HOUR = 20;
export const WRITE_LIMIT_MAX_PER_HOUR = 1000;

/** Strict parse: digits only, 0..1000. Unset or empty gives the default (20). */
export function parseWriteLimitPerHour(value: string | undefined): number {
  return parseBoundedInteger(
    value,
    WRITE_LIMIT_DEFAULT_PER_HOUR,
    'YNAB_WRITE_LIMIT_PER_HOUR',
    0,
    WRITE_LIMIT_MAX_PER_HOUR
  );
}
