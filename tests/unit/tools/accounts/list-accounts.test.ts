/**
 * List Accounts Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListAccounts } from '../../../../src/tools/accounts/list-accounts.js';
import {
  createMockClient,
  createAccountsResponse,
  mockAllAccounts,
  mockCheckingAccount,
  mockMortgageAccount,
  mockCreditCardWithOverpayment,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListAccounts', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('groups accounts by type with balances and summary', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.accounts_by_type.checking).toBeDefined();
    expect(parsed.accounts_by_type.checking[0]).toHaveProperty('id');
    expect(parsed.accounts_by_type.checking[0]).toHaveProperty('balance');
    expect(parsed.accounts_by_type.checking[0]).toHaveProperty('cleared_balance');
    expect(parsed.summary.total_accounts).toBeGreaterThan(0);
    expect(parsed.summary.total_assets).toContain('$');
    expect(parsed.summary.total_liabilities).toContain('$');
    expect(parsed.summary.net_worth).toContain('$');
  });

  it('excludes closed accounts by default', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    const allNames = Object.values(parsed.accounts_by_type)
      .flat()
      .map((a) => (a as { name: string }).name);
    expect(allNames).not.toContain('Old Savings');
  });

  it('includes closed accounts when include_closed=true', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleListAccounts({ include_closed: true }, mockClient as never);
    const parsed = JSON.parse(result);

    const allNames = Object.values(parsed.accounts_by_type)
      .flat()
      .map((a) => (a as { name: string }).name);
    expect(allNames).toContain('Old Savings');
  });

  it('reports liability_credits when overpayment exists', async () => {
    mockClient.getAccounts.mockResolvedValue(
      createAccountsResponse([mockCreditCardWithOverpayment])
    );

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.liability_credits).toBeDefined();
    expect(parsed.summary.liability_credits).toContain('$');
  });

  it('omits liability_credits when none exist', async () => {
    // mockAllAccounts includes the overpayment card; drop it so the omission
    // branch is actually exercised.
    const accountsWithoutCredits = mockAllAccounts.filter(
      (a) => a.id !== mockCreditCardWithOverpayment.id
    );
    mockClient.getAccounts.mockResolvedValue(
      createAccountsResponse(accountsWithoutCredits)
    );

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.liability_credits).toBeUndefined();
  });

  it('resolves custom budget_id', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse([]));

    await handleListAccounts({ budget_id: 'b-1' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-1');
    expect(mockClient.getAccounts).toHaveBeenCalledWith('b-1');
  });

  it('handles empty account list', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse([]));

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_accounts).toBe(0);
    expect(parsed.summary.liability_credits).toBeUndefined();
  });

  it('includes account detail fields and omits empty debt maps', async () => {
    mockClient.getAccounts.mockResolvedValue(
      createAccountsResponse([mockCheckingAccount, mockMortgageAccount])
    );

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    const checking = parsed.accounts_by_type.checking[0];
    expect(checking.on_budget).toBe(true);
    expect(checking.closed).toBe(false);
    expect(checking.note).toBe('Main checking account');
    expect(checking.last_reconciled_at).toBe('2024-01-15T12:00:00Z');
    expect(checking.direct_import_linked).toBe(true);
    expect(checking.direct_import_in_error).toBe(false);
    expect(checking.transfer_payee_id).toBe('tp-checking-111');
    expect(checking.debt_original_balance).toBeNull();
    expect(checking.debt_interest_rates).toBeUndefined();
    expect(checking.debt_minimum_payments).toBeUndefined();
    // Existing fields are unchanged
    expect(checking.balance).toBe('$2500.00');
    expect(checking.cleared_balance).toBe('$2400.00');

    const mortgage = parsed.accounts_by_type.mortgage[0];
    expect(mortgage.debt_original_balance).toBe('-$300000.00');
    expect(mortgage.debt_interest_rates).toEqual(mockMortgageAccount.debt_interest_rates);
    expect(mortgage.debt_interest_rates_formatted).toEqual({ '44444444-4444-4444-4444-444444444444': '4.5%' });
    expect(mortgage.debt_minimum_payments).toEqual(mockMortgageAccount.debt_minimum_payments);
    expect(Object.values(mortgage.debt_minimum_payments_formatted)).toEqual(['$1500.00']);
    expect(mortgage.debt_escrow_amounts).toBeUndefined();
  });

  it('sanitizes the account note', async () => {
    mockClient.getAccounts.mockResolvedValue(
      createAccountsResponse([{ ...mockCheckingAccount, note: 'hi\u0000 there\u0007' }])
    );

    const result = await handleListAccounts({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.accounts_by_type.checking[0].note).toBe('hi there');
  });
});
