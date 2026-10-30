/**
 * Error Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
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

  it('should not echo client-supplied values from real zod errors', () => {
    const schema = z.object({ id: z.guid(), n: z.number().max(5) }).strict();
    const secret = 'SECRET-VALUE-123';
    const parsed = schema.safeParse({ id: secret, n: 99, [secret]: secret });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = JSON.parse(formatErrorResponse(parsed.error));
    expect(result.type).toBe('validation_error');
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('99');
    expect(result.issues.map((i: { field: string }) => i.field)).toContain('id');
  });

  it('should keep author messages on regex/guid/min checks but not zod defaults', () => {
    const schema = z.object({
      month: z.string().regex(/^\d{4}-\d{2}-01$/, 'Month must be first-of-month format (YYYY-MM-01)'),
      id: z.guid('Invalid payee UUID format'),
      name: z.string().min(1, 'Name is required'),
      plain: z.string().regex(/^abc$/),
      short: z.string().min(5),
    });
    const parsed = schema.safeParse({ month: '2024-01-15', id: 'x', name: '', plain: 'zzz-secret', short: 'ab' });
    if (parsed.success) throw new Error('expected failure');
    const result = JSON.parse(formatErrorResponse(parsed.error));
    const byField = Object.fromEntries(result.issues.map((i: { field: string; message: string }) => [i.field, i.message]));
    expect(byField.month).toBe('Month must be first-of-month format (YYYY-MM-01)');
    expect(byField.id).toBe('Invalid payee UUID format');
    expect(byField.name).toBe('Name is required');
    expect(byField.plain).toBe('Invalid format');
    expect(byField.short).toBe('Value is too small or too short');
  });

  it('should keep custom refine messages from our own schemas', () => {
    const schema = z.string().refine(() => false, { message: 'Month must be YYYY-MM-DD' });
    const parsed = schema.safeParse('x');
    if (parsed.success) throw new Error('expected failure');
    const result = JSON.parse(formatErrorResponse(parsed.error));
    expect(result.issues[0].message).toBe('Month must be YYYY-MM-DD');
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
    // Uses mapped message, not upstream detail (to prevent data leakage)
    expect(result.message).toBe('Not found');
  });
});
