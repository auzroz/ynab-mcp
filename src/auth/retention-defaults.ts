/**
 * Retention windows for MCP grants and registrations (#54).
 *
 * These are the defaults the maintainer approved on 2026-11-09. Storage
 * enforces them on reads (refresh-token expiry) and in `sweepExpired`. #54b
 * makes each one a bounds-checked setting (`MCP_REFRESH_TOKEN_IDLE_DAYS`,
 * `MCP_REFRESH_TOKEN_TTL_DAYS` and the two client-sweep windows) and passes the
 * result to the storage factory as a {@link RetentionPolicy}.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A refresh token not used (rotated) for this long expires. */
export const REFRESH_TOKEN_IDLE_DAYS = 30;

/** A grant family expires this long after its authorization-code exchange, however often it is refreshed. */
export const REFRESH_TOKEN_TTL_DAYS = 90;

/** A registered client that never completed an authorization is swept this long after registering. */
export const ABANDONED_CLIENT_HOURS = 24;

/** A client with no live grant is swept this long after its last authorization. */
export const UNUSED_CLIENT_DAYS = 90;

/** Rows deleted per statement by `sweepExpired`, so one sweep never holds a large lock set. */
export const SWEEP_BATCH_SIZE = 500;

/** The retention windows, in milliseconds. */
export interface RetentionPolicy {
  /** Idle limit of a refresh token: time since it was issued (each rotation issues a new one). */
  refreshTokenIdleMs: number;
  /** Absolute limit of a grant family: time since its code exchange. */
  refreshTokenTtlMs: number;
  /** Registered clients that never completed authorization are swept after this. */
  abandonedClientMs: number;
  /** Clients with no live grant are swept this long after their last authorization. */
  unusedClientMs: number;
}

export const DEFAULT_RETENTION: Readonly<RetentionPolicy> = Object.freeze({
  refreshTokenIdleMs: REFRESH_TOKEN_IDLE_DAYS * DAY_MS,
  refreshTokenTtlMs: REFRESH_TOKEN_TTL_DAYS * DAY_MS,
  abandonedClientMs: ABANDONED_CLIENT_HOURS * HOUR_MS,
  unusedClientMs: UNUSED_CLIENT_DAYS * DAY_MS,
});

/** {@link DEFAULT_RETENTION} with any given windows replaced. */
export function retentionPolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  const policy = { ...DEFAULT_RETENTION, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Retention window ${key} must be a positive integer number of milliseconds`);
    }
  }
  return policy;
}
