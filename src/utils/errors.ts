/**
 * Custom Error Classes
 *
 * Provides structured error handling for the YNAB MCP server.
 */

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
 * Error thrown when the YNAB API returns an error.
 */
export class YnabApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'YnabApiError';
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
 */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super('Rate limit exceeded. Please wait before making more requests.');
    this.name = 'RateLimitError';
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
      message: error.message,
      suggestion: 'Set YNAB_READ_ONLY=false in your environment to enable write operations.',
    }, null, 2);
  }

  if (error instanceof RateLimitError) {
    return JSON.stringify({
      error: true,
      type: 'rate_limit',
      message: error.message,
      retry_after_ms: error.retryAfterMs,
      suggestion: 'Wait before making more requests. The server has a budget of 180 requests per hour.',
    }, null, 2);
  }

  if (error instanceof ValidationError) {
    return JSON.stringify({
      error: true,
      type: 'validation_error',
      message: error.message,
      field: error.field,
      suggestion: 'Check that all input parameters are valid.',
    }, null, 2);
  }

  if (error instanceof NotFoundError) {
    return JSON.stringify({
      error: true,
      type: 'not_found',
      message: error.message,
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
    // Return sanitized response without raw details
    return JSON.stringify({
      error: true,
      type: 'ynab_api_error',
      code: error.code,
      message: sanitizeErrorMessage(error.message) || errorInfo.message,
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
    // Return sanitized response
    return JSON.stringify({
      error: true,
      type: 'ynab_api_error',
      code: statusCode,
      message: sanitizeErrorMessage(error.error?.detail) || errorInfo.message,
      suggestion: errorInfo.suggestion,
    }, null, 2);
  }

  // Handle Zod validation errors
  if (isZodError(error)) {
    const issues = error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
      field: issue.path.join('.'),
      message: sanitizeErrorMessage(issue.message),
    }));
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
 * Type guard for Zod validation errors.
 */
function isZodError(error: unknown): error is { issues: { path: (string | number)[]; message: string }[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  );
}
