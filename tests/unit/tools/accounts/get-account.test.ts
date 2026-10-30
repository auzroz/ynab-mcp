/**
 * Get Account Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetAccount } from '../../../../src/tools/accounts/get-account.js';
import {
  createMockClient,
  createAccountResponse,
  mockCheckingAccount,
  mockMortgageAccount,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleGetAccount', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns account details', async () => {
    mockClient.getAccountById.mockResolvedValue(createAccountResponse(mockCheckingAccount));

    const result = await handleGetAccount(
      { account_id: mockCheckingAccount.id },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.account.id).toBe(mockCheckingAccount.id);
    expect(parsed.account.name).toBe('Primary Checking');
    expect(parsed.account.type).toBe('checking');
    expect(parsed.account.on_budget).toBe(true);
    expect(parsed.account.closed).toBe(false);
    expect(parsed.account.balance).toContain('$');
    expect(parsed.account.debt_original_balance).toBeNull();
  });

  it('resolves budget_id and calls client with account_id', async () => {
    mockClient.getAccountById.mockResolvedValue(createAccountResponse(mockCheckingAccount));

    await handleGetAccount(
      { budget_id: 'b-9', account_id: mockCheckingAccount.id },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-9');
    expect(mockClient.getAccountById).toHaveBeenCalledWith('b-9', mockCheckingAccount.id);
  });

  it('formats debt_original_balance when present', async () => {
    mockClient.getAccountById.mockResolvedValue(createAccountResponse(mockMortgageAccount));

    const result = await handleGetAccount(
      { account_id: mockMortgageAccount.id },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.account.debt_original_balance).toContain('$');
    expect(parsed.account.type).toBe('mortgage');
  });

  it('adds formatted debt maps and the transfer payee id without changing raw fields', async () => {
    mockClient.getAccountById.mockResolvedValue(createAccountResponse(mockMortgageAccount));

    const result = await handleGetAccount(
      { account_id: mockMortgageAccount.id },
      mockClient as never
    );
    const account = JSON.parse(result).account;

    expect(account.debt_interest_rates).toEqual(mockMortgageAccount.debt_interest_rates);
    expect(account.debt_minimum_payments).toEqual(mockMortgageAccount.debt_minimum_payments);
    expect(Object.values(account.debt_minimum_payments_formatted)).toEqual(['$1500.00']);
    expect(account.debt_escrow_amounts).toEqual({});
    expect(account.debt_escrow_amounts_formatted).toEqual({});
    expect(account.transfer_payee_id).toBe(mockMortgageAccount.transfer_payee_id);
    expect(account.last_reconciled_at).toBe(mockMortgageAccount.last_reconciled_at);
  });
});
