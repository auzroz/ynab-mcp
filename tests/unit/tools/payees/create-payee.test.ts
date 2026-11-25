/**
 * Create Payee Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreatePayee as rawHandleCreatePayee, createPayeeOutputSchema } from '../../../../src/tools/payees/create-payee.js';
import { validating } from '../output-validation.js';
import { createMockClient, createPayeeResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleCreatePayee = validating(createPayeeOutputSchema, rawHandleCreatePayee);

describe('handleCreatePayee', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates a payee and returns success', async () => {
    mockClient.createPayee.mockResolvedValue(
      createPayeeResponse({ id: 'new-payee', name: 'New Store', transfer_account_id: null, deleted: false })
    );

    const parsed = await handleCreatePayee({ name: 'New Store' }, mockClient as never);

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

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-6', { fresh: true });
    expect(mockClient.createPayee).toHaveBeenCalledWith('b-6', {
      payee: { name: 'New Store' },
    });
  });
});
