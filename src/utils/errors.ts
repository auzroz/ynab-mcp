/**
 * Custom Error Classes
 *
 * Provides structured error handling for the YNAB MCP server.
 */

import { z } from 'zod';
import { sanitizeErrorMessage } from './sanitize.js';

/**
 * Error thrown when a write operation is attempted in read-only mode.
 */
export class ReadOnlyModeError extends Error {
  constructor(operation: string) {
    super(
      `Operation "${operation}" is not allowed: server is in READ_ONLY mode. ` +
        `Set YNAB_READ_ONLY=false in your .env file to enable write operations.`
    );
    this.name = 'ReadOnlyModeError';
  }
}

/**
 * Error thrown when a user has used up their per-hour write cap (#61c).
 * The message is fixed: it names the limit and when it resets, nothing else.
 */
export class WriteLimitError extends Error {
  constructor(
    public readonly limit: number,
    /** Epoch ms at which the next write is allowed. */
    public readonly resetsAt: number,
    public readonly retryAfterMs: number,
    /** The first refusal of this episode: the one the audit log records (#60a). */
    public readonly firstRefusal = false
  ) {
    super(`Write limit of ${limit} per hour reached.`);
    this.name = 'WriteLimitError';
  }
}

/**
 * Error thrown when the YNAB API returns an error.
 */
export class YnabApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
    /** For a 429: seconds until requests are expected to succeed again. */
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'YnabApiError';
  }
}

/**
 * Error thrown when the user's YNAB access token can't be resolved for a
 * request (grant removed, refresh failed). The message is fixed; the cause is
 * logged server-side only.
 */
export class YnabAuthError extends Error {
  constructor(message = 'YNAB authorization unavailable') {
    super(message);
    this.name = 'YnabAuthError';
  }
}

/**
 * The user's YNAB access token can't be resolved right now, for a reason that
 * clears by itself (#48, Q1): YNAB timed out or answered 5xx, the circuit
 * breaker is open, or another replica's refresh outlasted the wait. The stored
 * YNAB grant is kept; retry after `retryAfterSeconds`. Only a rejected refresh
 * token (`invalid_grant`) is a plain {@link YnabAuthError}, which needs a
 * reconnect. Nothing was sent to YNAB's API, as for its parent class.
 */
export class YnabAuthUnavailableError extends YnabAuthError {
  constructor(public readonly retryAfterSeconds: number) {
    super('YNAB authorization temporarily unavailable');
    this.name = 'YnabAuthUnavailableError';
  }
}

/**
 * Error thrown when input validation fails.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown when rate limit is exceeded.
 *
 * Note: The server uses a configurable rate limit budget (default 180 requests/hour),
 * which is 10% below YNAB's official limit of 200 requests/hour. This provides a
 * safety margin for concurrent requests and avoids hitting the hard limit.
 * The actual limit is set via RATE_LIMIT_PER_HOUR environment variable.
 */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('Rate limit exceeded. Please wait before making more requests.');
    this.name = 'RateLimitError';
  }
}

/**
 * An outbound call to YNAB hit its deadline (#58). The message is fixed:
 * nothing from the upstream is carried. `outcomeUnknown` is true for a call that
 * may have changed something (any non-GET): it is never retried, and the caller
 * is told to check before trying again (ADR-0001 D6).
 */
export class OutboundTimeoutError extends Error {
  constructor(public readonly outcomeUnknown: boolean) {
    super('YNAB did not respond in time');
    this.name = 'OutboundTimeoutError';
  }
}

/**
 * The circuit breaker is open: YNAB has been failing for this user, so requests
 * fail fast for a while (#58). The message is fixed.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('YNAB is not responding; requests are paused briefly');
    this.name = 'CircuitOpenError';
  }
}

/**
 * Error thrown when a resource is not found.
 */
export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

/**
 * An account tool (#53c) refused by its policy (src/tools/connections/policy.ts):
 * the operator's read-only setting, or this connection's read-only grant.
 */
export class AccountChangeNotAllowedError extends Error {
  constructor(public readonly reason: 'scope' | 'read_only') {
    super('Account change not allowed');
    this.name = 'AccountChangeNotAllowedError';
  }
}

/**
 * `ynab_revoke_connection` found no connection of the caller's with that id.
 * The same for an unknown id and another user's: the message is fixed and
 * never echoes the id.
 */
export class ConnectionNotFoundError extends Error {
  constructor() {
    super('Connection not found');
    this.name = 'ConnectionNotFoundError';
  }
}

/**
 * YNAB API error codes and their meanings.
 */
export const YNAB_ERROR_CODES: Record<string, { message: string; suggestion: string }> = {
  '400': {
    message: 'Bad request',
    suggestion: 'Check that all required parameters are provided and valid.',
  },
  '401': {
    message: 'Unauthorized',
    suggestion: 'Authentication failed. Verify your credentials are valid and try again.',
  },
  '403': {
    message: 'Forbidden',
    suggestion: 'You do not have permission to access this resource.',
  },
  '404': {
    message: 'Not found',
    suggestion: 'The requested resource does not exist. Check the ID is correct.',
  },
  '409': {
    message: 'Conflict',
    suggestion: 'The resource has been modified. Refresh and try again.',
  },
  '429': {
    message: 'Too many requests',
    suggestion: 'Rate limit exceeded. Wait a moment before retrying.',
  },
  '500': {
    message: 'Internal server error',
    suggestion: 'YNAB is experiencing issues. Try again later.',
  },
  '503': {
    message: 'Service unavailable',
    suggestion: 'YNAB is temporarily unavailable. Try again later.',
  },
};

/**
 * Format an error as a structured JSON response for tool output.
 */
export function formatErrorResponse(error: unknown): string {
  if (error instanceof ReadOnlyModeError) {
    return JSON.stringify({
      error: true,
      type: 'read_only_mode',
      message: 'Write operation not allowed in read-only mode',
      suggestion: 'Set YNAB_READ_ONLY=false in your environment to enable write operations.',
    }, null, 2);
  }

  if (error instanceof YnabAuthUnavailableError) {
    return JSON.stringify({
      error: true,
      type: 'upstream_unavailable',
      message: 'YNAB authorization is temporarily unavailable',
      retry_after_seconds: error.retryAfterSeconds,
      suggestion: 'Try again after the retry time. The YNAB connection is kept; no reconnect is needed.',
    }, null, 2);
  }

  if (error instanceof WriteLimitError) {
    return JSON.stringify({
      error: true,
      type: 'write_limit_exceeded',
      message: `Write limit reached: at most ${error.limit} write requests per hour per user. The next write is allowed at ${new Date(error.resetsAt).toISOString()}.`,
      limit_per_hour: error.limit,
      resets_at: new Date(error.resetsAt).toISOString(),
      retry_after_seconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
      suggestion:
        'Nothing was changed. Wait until the reset time, or ask the server operator to raise YNAB_WRITE_LIMIT_PER_HOUR (0 disables the cap).',
    }, null, 2);
  }

  if (error instanceof YnabAuthError) {
    return JSON.stringify({
      error: true,
      type: 'auth_error',
      message: 'Could not get YNAB authorization for this request',
      // The cause may be a removed grant or a transient YNAB outage; both read the same here.
      suggestion: 'Try again shortly. If it keeps failing, reconnect this server to YNAB (re-authorize).',
    }, null, 2);
  }

  if (error instanceof RateLimitError) {
    return JSON.stringify({
      error: true,
      type: 'rate_limited',
      message: 'Rate limit exceeded',
      retry_after_ms: error.retryAfterMs,
      // At least 1: "0 seconds" would invite an immediate retry that fails again.
      retry_after_seconds:
        error.retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
      // Note: Server uses 180 req/hr budget (10% below YNAB's 200 limit) for safety margin
      suggestion: 'Wait before making more requests. Check ynab_rate_limit_status for current limits.',
    }, null, 2);
  }

  if (error instanceof OutboundTimeoutError) {
    return JSON.stringify({
      error: true,
      type: 'upstream_timeout',
      message: error.outcomeUnknown
        ? 'YNAB did not respond in time; the change may still have been applied'
        : 'YNAB did not respond in time',
      ...(error.outcomeUnknown ? { outcome: 'unknown' } : {}),
      suggestion: error.outcomeUnknown
        ? 'Check whether the change was applied (for example by listing the resource) before retrying it.'
        : 'Try again shortly.',
    }, null, 2);
  }

  if (error instanceof CircuitOpenError) {
    return JSON.stringify({
      error: true,
      type: 'upstream_unavailable',
      message: 'YNAB is not responding; requests are paused briefly',
      retry_after_ms: error.retryAfterMs,
      retry_after_seconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)),
      suggestion: 'Try again after the retry time.',
    }, null, 2);
  }

  if (error instanceof ValidationError) {
    return JSON.stringify({
      error: true,
      type: 'validation_error',
      message: sanitizeErrorMessage(error.message) || 'Validation failed',
      field: error.field,
      suggestion: 'Check that all input parameters are valid.',
    }, null, 2);
  }

  if (error instanceof AccountChangeNotAllowedError) {
    return JSON.stringify({
      error: true,
      type: 'account_change_not_allowed',
      reason: error.reason,
      message:
        error.reason === 'read_only'
          ? 'Not allowed: this server is read-only, so connections cannot be revoked or erased from here'
          : 'Not allowed: this connection or the YNAB grant is read-only, so it cannot revoke connections or disconnect',
      suggestion:
        error.reason === 'read_only'
          ? 'Ask the server operator, or remove the access at YNAB (app.ynab.com/settings, Authorized Applications).'
          : 'Reconnect with read & write access, ask the server operator, or remove the access at YNAB (app.ynab.com/settings, Authorized Applications).',
    }, null, 2);
  }

  if (error instanceof ConnectionNotFoundError) {
    return JSON.stringify({
      error: true,
      type: 'not_found',
      message: 'No connection of yours has that family_id',
      suggestion: 'List your connections with ynab_list_connections and use a family_id from there. A connection that has already been revoked or has expired is no longer listed.',
    }, null, 2);
  }

  if (error instanceof NotFoundError) {
    return JSON.stringify({
      error: true,
      type: 'not_found',
      message: sanitizeErrorMessage(error.message) || 'Resource not found',
      suggestion: 'Verify the ID exists by listing available resources first.',
    }, null, 2);
  }

  if (error instanceof YnabApiError) {
    const errorInfo = YNAB_ERROR_CODES[error.code] ?? {
      message: 'Unknown error',
      suggestion: 'Check the YNAB API documentation for more information.',
    };
    // Log sanitized error server-side for debugging (no raw details)
    console.error('[YnabApiError]', error.code, sanitizeErrorMessage(error.message));
    // Return mapped message only (no upstream error text to prevent data leakage)
    return JSON.stringify({
      error: true,
      type: 'ynab_api_error',
      code: error.code,
      message: errorInfo.message,
      ...(error.retryAfterSeconds !== undefined ? { retry_after_seconds: error.retryAfterSeconds } : {}),
      suggestion: errorInfo.suggestion,
    }, null, 2);
  }

  // Handle YNAB SDK errors
  if (isYnabSdkError(error)) {
    const statusCode = String(error.error?.id ?? 'unknown');
    const errorInfo = YNAB_ERROR_CODES[statusCode] ?? {
      message: 'Unknown error',
      suggestion: 'Check the YNAB API documentation.',
    };
    // Log sanitized error server-side for debugging
    console.error('[YnabSdkError]', statusCode, sanitizeErrorMessage(error.error?.detail));
    // Return mapped message only (no upstream error text to prevent data leakage)
    return JSON.stringify({
      error: true,
      type: 'ynab_api_error',
      code: statusCode,
      message: errorInfo.message,
      suggestion: errorInfo.suggestion,
    }, null, 2);
  }

  // Handle Zod validation errors
  if (isZodError(error)) {
    const issues = error.issues.map((issue: { path?: unknown; code?: unknown; message?: unknown }) => {
      // Defensive checks for malformed issue shapes
      const path = Array.isArray(issue.path)
        ? issue.path.map((segment) => sanitizeErrorMessage(String(segment))).join('.')
        : '';
      return { field: path, message: mapZodIssueMessage(issue) };
    });
    return JSON.stringify({
      error: true,
      type: 'validation_error',
      message: 'Invalid input parameters',
      issues,
      suggestion: 'Check that all required parameters are provided with correct types.',
    }, null, 2);
  }

  // Generic error - log sanitized error server-side, return sanitized message
  console.error('[UnknownError]', sanitizeErrorMessage(error));
  return JSON.stringify({
    error: true,
    type: 'unknown_error',
    message: sanitizeErrorMessage(error),
    suggestion: 'An unexpected error occurred. Check the server logs for details.',
  }, null, 2);
}

/**
 * Type guard for YNAB SDK errors.
 */
function isYnabSdkError(error: unknown): error is { error: { id: string; detail?: string } } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as { error: unknown }).error === 'object' &&
    (error as { error: { id?: unknown } }).error !== null &&
    'id' in ((error as { error: object }).error)
  );
}

/**
 * Map a Zod issue to a client-safe message. Zod 4 messages can echo
 * client-supplied values (e.g. unrecognized key names), so only the issue code
 * is trusted. Messages written in our own schemas are kept: refine issues
 * (code 'custom') and regex/guid/min checks whose message differs from zod's
 * built-in English text for that issue.
 */
function isAuthorMessage(issue: object, message: unknown): boolean {
  if (typeof message !== 'string') return false;
  try {
    const def = z.locales.en().localeError(issue as never);
    const defMsg = typeof def === 'string' ? def : def?.message;
    return defMsg !== message;
  } catch {
    return false;
  }
}

/**
 * Client-facing message for one zod issue: our own schema messages pass through
 * (sanitized); zod's built-in text, which can echo patterns or key names, is
 * replaced by a generic message for the issue code.
 */
function mapZodIssueMessage(issue: { code?: unknown; message?: unknown }): string {
  const { code, message } = issue;
  if ((code === 'invalid_format' || code === 'too_small' || code === 'too_big') && isAuthorMessage(issue, message)) {
    return sanitizeErrorMessage(message as string);
  }
  switch (code) {
    case 'invalid_type':
      return 'Invalid type';
    case 'invalid_format':
      return 'Invalid format';
    case 'invalid_value':
    case 'not_multiple_of':
      return 'Invalid value';
    case 'invalid_union':
      return 'Invalid input';
    case 'too_big':
      return 'Value is too large or too long';
    case 'too_small':
      return 'Value is too small or too short';
    case 'unrecognized_keys':
      return 'Unrecognized parameter';
    case 'invalid_key':
    case 'invalid_element':
      return 'Invalid entry';
    case 'custom':
      return typeof message === 'string' ? sanitizeErrorMessage(message) : 'Validation error';
    default:
      return 'Validation error';
  }
}

/**
 * Whether a tool call failed its Zod input validation, which every handler
 * runs before its first YNAB request (the write cap gives such a call's slot back).
 */
export function isInputValidationError(error: unknown): boolean {
  return isZodError(error);
}

/**
 * Type guard for Zod validation errors.
 */
function isZodError(error: unknown): error is { issues: { path: (string | number)[]; code?: string; message: string }[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  );
}
