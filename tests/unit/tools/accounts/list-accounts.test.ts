/**
 * List Accounts Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListAccounts } from '../../../../src/tools/accounts/list-accounts.js';
import {
  createMockClient,
  createAccountsResponse,
  mockAllAccounts,
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
});
