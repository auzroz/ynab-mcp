/**
 * Update Payee Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleUpdatePayee } from '../../../../src/tools/payees/update-payee.js';
import { createMockClient, createPayeeResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const PAYEE_UUID = '22222222-2222-2222-2222-2222222222bb';

describe('handleUpdatePayee', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('renames a payee and returns success', async () => {
    mockClient.updatePayee.mockResolvedValue(
      createPayeeResponse({ id: PAYEE_UUID, name: 'New Name', transfer_account_id: null, deleted: false })
    );

    const result = await handleUpdatePayee(
      { payee_id: PAYEE_UUID, name: 'New Name' },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('renamed');
    expect(parsed.payee.name).toBe('New Name');
    expect(parsed.payee.id).toBe(PAYEE_UUID);
  });

  it('calls client.updatePayee with resolved budget, id, and name', async () => {
    mockClient.updatePayee.mockResolvedValue(
      createPayeeResponse({ id: PAYEE_UUID, name: 'New Name', transfer_account_id: null, deleted: false })
    );

    await handleUpdatePayee(
      { budget_id: 'b-7', payee_id: PAYEE_UUID, name: 'New Name' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-7');
    expect(mockClient.updatePayee).toHaveBeenCalledWith('b-7', PAYEE_UUID, {
      payee: { name: 'New Name' },
    });
  });
});
