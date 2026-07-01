/**
 * Get User Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetUser } from '../../../../src/tools/user/get-user.js';
import { createMockClient, createUserResponse, mockUser } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleGetUser', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it("returns the authenticated user's id", async () => {
    mockClient.getUser.mockResolvedValue(createUserResponse());

    const result = await handleGetUser({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.user.id).toBe(mockUser.id);
    expect(mockClient.getUser).toHaveBeenCalledTimes(1);
  });
});
