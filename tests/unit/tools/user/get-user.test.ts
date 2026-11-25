/**
 * Get User Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetUser as rawHandleGetUser, getUserOutputSchema } from '../../../../src/tools/user/get-user.js';
import { validating } from '../output-validation.js';
import { createMockClient, createUserResponse, mockUser } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleGetUser = validating(getUserOutputSchema, rawHandleGetUser);

describe('handleGetUser', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it("returns the authenticated user's id", async () => {
    mockClient.getUser.mockResolvedValue(createUserResponse());

    const parsed = await handleGetUser({}, mockClient as never);

    expect(parsed.user.id).toBe(mockUser.id);
    expect(mockClient.getUser).toHaveBeenCalledTimes(1);
  });
});
