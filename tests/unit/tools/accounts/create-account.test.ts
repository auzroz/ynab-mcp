/**
 * Create Account Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateAccount } from '../../../../src/tools/accounts/create-account.js';
import { createMockClient, createAccountResponse } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleCreateAccount', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('creates an account and returns success', async () => {
    mockClient.createAccount.mockResolvedValue(createAccountResponse());

    const result = await handleCreateAccount(
      { name: 'New Checking', type: 'checking', balance: 1000.5 },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('created successfully');
    expect(parsed.account).toHaveProperty('id');
    expect(parsed.account).toHaveProperty('balance');
  });

  it('calls client.createAccount with milliunit balance and resolved budget', async () => {
    mockClient.createAccount.mockResolvedValue(createAccountResponse());

    await handleCreateAccount(
      { budget_id: 'b-1', name: 'New Checking', type: 'checking', balance: 1000.5 },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-1');
    expect(mockClient.createAccount).toHaveBeenCalledWith('b-1', {
      account: {
        name: 'New Checking',
        type: 'checking',
        balance: 1000500,
      },
    });
  });

  it('supports negative balances for liability account types', async () => {
    mockClient.createAccount.mockResolvedValue(createAccountResponse());

    await handleCreateAccount(
      { name: 'Card', type: 'creditCard', balance: -500 },
      mockClient as never
    );

    expect(mockClient.createAccount).toHaveBeenCalledWith('test-budget-id', {
      account: {
        name: 'Card',
        type: 'creditCard',
        balance: -500000,
      },
    });
  });
});
