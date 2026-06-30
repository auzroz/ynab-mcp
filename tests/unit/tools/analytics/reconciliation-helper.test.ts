/**
 * Reconciliation Helper Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleReconciliationHelper } from '../../../../src/tools/analytics/reconciliation-helper.js';
import {
  createMockClient,
  createAccountsResponse,
  createCategoriesResponse,
  createTransactionsResponse,
  mockAllAccounts,
  mockCheckingAccount,
  mockUnclearedTransaction,
  mockFlaggedTransaction,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleReconciliationHelper', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-01T12:00:00Z'));
    mockClient = createMockClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports up_to_date when there are no uncleared transactions', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    // All cleared/reconciled transactions get filtered out
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));

    const result = JSON.parse(await handleReconciliationHelper({}, mockClient as never));

    expect(result.status).toBe('up_to_date');
    expect(result.message).toContain('cleared or reconciled');
    expect(result.summary.total_uncleared_transactions).toBe(0);
    expect(result.accounts).toEqual([]);
  });

  it('lists uncleared transactions grouped by account', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse([mockUnclearedTransaction])
    );

    const result = JSON.parse(await handleReconciliationHelper({}, mockClient as never));

    expect(result.summary.total_uncleared_transactions).toBe(1);
    expect(result.accounts.length).toBe(1);
    expect(result.accounts[0].account).toBe('Primary Checking');
    expect(result.accounts[0].uncleared_count).toBe(1);
    expect(result.accounts[0].transactions[0].payee).toBe('Target');
    expect(result.accounts[0].transactions[0].category).toBe('Shopping');
  });

  it('flags accounts needing attention when oldest pending is over a week', async () => {
    // Transaction date 2024-01-01, "today" is 2024-02-01 => 31 days pending
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse([
        { ...mockUnclearedTransaction, id: 'old-uncleared', date: '2024-01-01' },
      ])
    );

    const result = JSON.parse(await handleReconciliationHelper({}, mockClient as never));

    expect(result.status).toBe('overdue');
    expect(result.summary.accounts_needing_attention).toBe(1);
    expect(result.accounts[0].transactions[0].days_pending).toBeGreaterThan(7);
  });

  it('reports needs_attention for recent uncleared transactions', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse([
        { ...mockUnclearedTransaction, id: 'recent-uncleared', date: '2024-01-30' },
      ])
    );

    const result = JSON.parse(await handleReconciliationHelper({}, mockClient as never));

    expect(result.status).toBe('needs_attention');
    expect(result.summary.accounts_needing_attention).toBe(0);
  });

  it('filters to a specific account_id', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    mockClient.getTransactions.mockResolvedValue(
      createTransactionsResponse([mockUnclearedTransaction, mockFlaggedTransaction])
    );

    const result = JSON.parse(
      await handleReconciliationHelper(
        { account_id: mockCheckingAccount.id },
        mockClient as never
      )
    );

    // Specific account always shown even though all txns are on it here
    expect(result.accounts.length).toBe(1);
    expect(result.accounts[0].account).toBe('Primary Checking');
  });

  it('throws when account_id does not match any active account', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));

    await expect(
      handleReconciliationHelper(
        { account_id: '99999999-9999-9999-9999-999999999999' },
        mockClient as never
      )
    ).rejects.toThrow('Account not found');
  });

  it('passes through budget_id to resolveBudgetId', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
    mockClient.getTransactions.mockResolvedValue(createTransactionsResponse([]));

    await handleReconciliationHelper({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
