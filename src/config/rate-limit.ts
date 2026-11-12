/**
 * RATE_LIMIT_MAX_WAIT_MS: how long a request may wait for a rate-limit token
 * before failing with `rate_limited`. Kept in its own file so the config
 * loaders need only one call each.
 */

export const RATE_LIMIT_MAX_WAIT_DEFAULT_MS = 2000;
export const RATE_LIMIT_MAX_WAIT_MAX_MS = 60_000;

/**
 * Strict parse: digits only (no "2s", no "-1", no "1.5"), then 0..60000.
 * 0 means never wait. Unset or empty gives the default.
 */
export function parseRateLimitMaxWaitMs(value: string | undefined): number {
  if (value === undefined || value === '') return RATE_LIMIT_MAX_WAIT_DEFAULT_MS;
  const bounds = `an integer from 0 to ${RATE_LIMIT_MAX_WAIT_MAX_MS} (milliseconds; 0 = never wait)`;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid RATE_LIMIT_MAX_WAIT_MS: expected ${bounds}.`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > RATE_LIMIT_MAX_WAIT_MAX_MS) {
    throw new Error(`Invalid RATE_LIMIT_MAX_WAIT_MS: expected ${bounds}.`);
  }
  return n;
}
