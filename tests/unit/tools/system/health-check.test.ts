/**
 * Health Check Tool Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { handleHealthCheck } from '../../../../src/tools/system/health-check.js';
import { createMockClient, createUserResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

interface HealthCheckCheck {
  name: string;
  status: 'pass' | 'fail';
  message?: string;
  error?: string;
}

describe('handleHealthCheck', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getUser.mockResolvedValue(createUserResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports healthy when all checks pass (read-only mode)', async () => {
    const result = await handleHealthCheck({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('healthy');
    expect(parsed.message).toBe('All systems operational');

    const apiCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'api_connectivity');
    expect(apiCheck.status).toBe('pass');

    const writeCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'write_operations');
    expect(writeCheck.message).toContain('READ-ONLY');

    expect(parsed.summary.failed).toBe(0);
    expect(mockClient.getUser).toHaveBeenCalledTimes(1);
  });

  it('reports unhealthy when getUser rejects (api connectivity fails)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockClient.getUser.mockRejectedValue(new Error('network down'));

    const result = await handleHealthCheck({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('unhealthy');
    expect(parsed.message).toContain('check(s) failed');

    const apiCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'api_connectivity');
    expect(apiCheck.status).toBe('fail');
    expect(apiCheck.error).toBe('Failed to connect to YNAB API');
    expect(parsed.summary.failed).toBe(1);
  });

  it('reports write operations enabled when not read-only', async () => {
    mockClient.isReadOnly.mockReturnValue(false);

    const result = await handleHealthCheck({}, mockClient as never);
    const parsed = JSON.parse(result);

    const writeCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'write_operations');
    expect(writeCheck.message).toContain('ENABLED');
  });

  it('reports rate limiter failure when canMakeRequest is false', async () => {
    mockClient.getRateLimitStatus.mockReturnValue({
      available: 0,
      limit: 180,
      used: 180,
      percentUsed: 100,
      canMakeRequest: false,
      waitTimeMs: 1000,
      resetTimeMs: 3600000,
    });

    const result = await handleHealthCheck({}, mockClient as never);
    const parsed = JSON.parse(result);

    const rateCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'rate_limiter');
    expect(rateCheck.status).toBe('fail');
    expect(rateCheck.message).toBe('Rate limit exhausted');
    expect(parsed.status).toBe('unhealthy');
  });

  it('masks a configured default budget id', async () => {
    mockClient.getDefaultBudgetId.mockReturnValue('abcdefgh-1234-5678-9012-zzzzzzzzzzzz');

    const result = await handleHealthCheck({}, mockClient as never);
    const parsed = JSON.parse(result);

    const budgetCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'default_budget');
    expect(budgetCheck.message).toContain('abcd...zzzz');
    expect(budgetCheck.message).not.toContain('abcdefgh-1234');
  });

  it('reports last-used when default budget is not set', async () => {
    mockClient.getDefaultBudgetId.mockReturnValue('last-used');

    const result = await handleHealthCheck({}, mockClient as never);
    const parsed = JSON.parse(result);

    const budgetCheck = parsed.checks.find((c: HealthCheckCheck) => c.name === 'default_budget');
    expect(budgetCheck.message).toContain('last-used');
  });

  it('rejects unexpected properties (strict schema)', async () => {
    await expect(handleHealthCheck({ foo: 'bar' }, mockClient as never)).rejects.toThrow();
  });
});
