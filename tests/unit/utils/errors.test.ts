/**
 * Error Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ReadOnlyModeError,
  YnabApiError,
  ValidationError,
  RateLimitError,
  NotFoundError,
  formatErrorResponse,
} from '../../../src/utils/errors.js';

describe('Error Classes', () => {
  describe('ReadOnlyModeError', () => {
    it('should create error with operation name', () => {
      const error = new ReadOnlyModeError('createTransaction');
      expect(error.name).toBe('ReadOnlyModeError');
      expect(error.message).toContain('createTransaction');
      expect(error.message).toContain('READ_ONLY mode');
    });
  });

  describe('YnabApiError', () => {
    it('should create error with code and details', () => {
      const error = new YnabApiError('Not found', '404', { resource: 'budget' });
      expect(error.name).toBe('YnabApiError');
      expect(error.code).toBe('404');
      expect(error.details).toEqual({ resource: 'budget' });
    });
  });

  describe('ValidationError', () => {
    it('should create error with field name', () => {
      const error = new ValidationError('Invalid date format', 'since_date');
      expect(error.name).toBe('ValidationError');
      expect(error.field).toBe('since_date');
    });
  });

  describe('RateLimitError', () => {
    it('should create error with retry time', () => {
      const error = new RateLimitError(5000);
      expect(error.name).toBe('RateLimitError');
      expect(error.retryAfterMs).toBe(5000);
    });
  });

  describe('NotFoundError', () => {
    it('should create error with resource and id', () => {
      const error = new NotFoundError('Budget', 'abc-123');
      expect(error.name).toBe('NotFoundError');
      expect(error.message).toContain('Budget');
      expect(error.message).toContain('abc-123');
    });
  });
});

describe('formatErrorResponse', () => {
  it('should format ReadOnlyModeError', () => {
    const error = new ReadOnlyModeError('deleteTransaction');
    const result = JSON.parse(formatErrorResponse(error));

    expect(result.error).toBe(true);
    expect(result.type).toBe('read_only_mode');
    expect(result.message).toContain('read-only');
  });

  it('should format RateLimitError', () => {
    const error = new RateLimitError(10000);
    const result = JSON.parse(formatErrorResponse(error));

    expect(result.error).toBe(true);
    expect(result.type).toBe('rate_limit');
    expect(result.retry_after_ms).toBe(10000);
  });

  it('should format ValidationError', () => {
    const error = new ValidationError('Invalid amount', 'amount');
    const result = JSON.parse(formatErrorResponse(error));

    expect(result.error).toBe(true);
    expect(result.type).toBe('validation_error');
    expect(result.field).toBe('amount');
  });

  it('should format NotFoundError', () => {
    const error = new NotFoundError('Account', 'xyz-456');
    const result = JSON.parse(formatErrorResponse(error));

    expect(result.error).toBe(true);
    expect(result.type).toBe('not_found');
    expect(result.message).toContain('Account');
  });

  it('should format YnabApiError with known code', () => {
    const error = new YnabApiError('Unauthorized', '401');
    const result = JSON.parse(formatErrorResponse(error));

    expect(result.error).toBe(true);
    expect(result.type).toBe('ynab_api_error');
    expect(result.code).toBe('401');
    expect(result.suggestion).toContain('Authentication failed');
  });

  it('should format generic Error', () => {
    const error = new Error('Something went wrong');
    const result = JSON.parse(formatErrorResponse(error));

    expect(result.error).toBe(true);
    expect(result.type).toBe('unknown_error');
    expect(result.message).toBe('Something went wrong');
  });

  it('should handle non-Error values', () => {
    const result = JSON.parse(formatErrorResponse('string error'));

    expect(result.error).toBe(true);
    expect(result.message).toBe('string error');
  });

  it('should format Zod-like validation errors', () => {
    const zodError = {
      issues: [
        { path: ['budget_id'], message: 'Required' },
        { path: ['amount'], message: 'Must be a number' },
      ],
    };
    const result = JSON.parse(formatErrorResponse(zodError));

    expect(result.error).toBe(true);
    expect(result.type).toBe('validation_error');
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].field).toBe('budget_id');
  });

  it('should format YNAB SDK errors', () => {
    const sdkError = {
      error: {
        id: '404',
        detail: 'Budget not found',
      },
    };
    const result = JSON.parse(formatErrorResponse(sdkError));

    expect(result.error).toBe(true);
    expect(result.type).toBe('ynab_api_error');
    expect(result.code).toBe('404');
    expect(result.message).toBe('Budget not found');
  });
});
