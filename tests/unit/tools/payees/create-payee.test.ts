/**
 * Create Payee Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreatePayee } from '../../../../src/tools/payees/create-payee.js';
import { createMockClient, createPayeeResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleCreatePayee', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates a payee and returns success', async () => {
    mockClient.createPayee.mockResolvedValue(
      createPayeeResponse({ id: 'new-payee', name: 'New Store', transfer_account_id: null, deleted: false })
    );

    const result = await handleCreatePayee({ name: 'New Store' }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('created successfully');
    expect(parsed.payee.id).toBe('new-payee');
    expect(parsed.payee.name).toBe('New Store');
  });

  it('calls client.createPayee with resolved budget and name', async () => {
    mockClient.createPayee.mockResolvedValue(
      createPayeeResponse({ id: 'new-payee', name: 'New Store', transfer_account_id: null, deleted: false })
    );

    await handleCreatePayee({ budget_id: 'b-6', name: 'New Store' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-6');
    expect(mockClient.createPayee).toHaveBeenCalledWith('b-6', {
      payee: { name: 'New Store' },
    });
  });
});
