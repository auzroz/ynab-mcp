/**
 * Rate Limit Status Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleRateLimitStatus } from '../../../../src/tools/system/rate-limit-status.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleRateLimitStatus', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('reports healthy status with default mock (low usage)', async () => {
    const result = await handleRateLimitStatus({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('healthy');
    expect(parsed.message).toContain('Plenty');
    expect(parsed.rate_limit.available_requests).toBe(180);
    expect(parsed.timing.can_make_request_now).toBe(true);
    expect(parsed.recommendations).toEqual([]);
  });

  it('reports warning status between 50% and 80% usage', async () => {
    mockClient.getRateLimitStatus.mockReturnValue({
      available: 108,
      limit: 180,
      used: 72,
      percentUsed: 60,
      canMakeRequest: true,
      waitTimeMs: 0,
      resetTimeMs: 120000,
    });

    const result = await handleRateLimitStatus({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('warning');
    expect(parsed.message).toContain('being consumed');
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(parsed.timing.full_reset_minutes).toBe(2);
  });

  it('reports critical status at >=80% usage and canMakeRequest false', async () => {
    mockClient.getRateLimitStatus.mockReturnValue({
      available: 0,
      limit: 180,
      used: 180,
      percentUsed: 100,
      canMakeRequest: false,
      waitTimeMs: 5000,
      resetTimeMs: 3600000,
    });

    const result = await handleRateLimitStatus({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('critical');
    expect(parsed.message).toContain('low');
    expect(parsed.timing.can_make_request_now).toBe(false);
    expect(parsed.timing.wait_time_seconds).toBe(5);
    expect(parsed.recommendations.length).toBeGreaterThan(0);
  });

  it('rejects unexpected properties (strict schema)', async () => {
    await expect(
      handleRateLimitStatus({ unexpected: true }, mockClient as never)
    ).rejects.toThrow();
  });
});
