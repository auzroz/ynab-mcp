/**
 * Credit Card Status Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreditCardStatus } from '../../../../src/tools/analytics/credit-card-status.js';
import {
  createMockClient,
  createAccountsResponse,
  createCategoriesResponse,
  createMonthResponse,
  mockMonthDetail,
  mockCheckingAccount,
  mockSavingsAccount,
  mockCreditCardAccount,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

// A month response that sets the Chase Visa payment category balance.
function monthWithPaymentBalance(balance: number) {
  return createMonthResponse({
    ...mockMonthDetail,
    categories: [
      {
        ...mockMonthDetail.categories[0]!,
        id: 'cat-cc-payment-hhh',
        name: 'Chase Visa',
        balance,
      },
    ],
  });
}

describe('handleCreditCardStatus', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    mockClient = createMockClient();
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns no_credit_cards when none are present', async () => {
    mockClient.getAccounts.mockResolvedValue(
      createAccountsResponse([mockCheckingAccount, mockSavingsAccount])
    );
    mockClient.getBudgetMonth.mockResolvedValue(monthWithPaymentBalance(0));

    const result = JSON.parse(await handleCreditCardStatus({}, mockClient as never));

    expect(result.status).toBe('no_credit_cards');
    expect(result.credit_cards).toEqual([]);
  });

  it('marks a card covered when payment category meets the balance owed', async () => {
    // Chase Visa owes $1,500; payment category has $1,500
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse([mockCreditCardAccount]));
    mockClient.getBudgetMonth.mockResolvedValue(monthWithPaymentBalance(1500000));

    const result = JSON.parse(await handleCreditCardStatus({}, mockClient as never));

    expect(result.status).toBe('all_covered');
    expect(result.credit_cards[0].status).toBe('covered');
    expect(result.summary.cards_covered).toBe(1);
  });

  it('marks a card underfunded when payment category is empty', async () => {
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse([mockCreditCardAccount]));
    mockClient.getBudgetMonth.mockResolvedValue(monthWithPaymentBalance(0));

    const result = JSON.parse(await handleCreditCardStatus({}, mockClient as never));

    expect(result.status).toBe('underfunded');
    expect(result.credit_cards[0].status).toBe('underfunded');
    expect(result.summary.total_shortfall).toBeDefined();
    expect(result.credit_cards[0].shortfall).not.toBeNull();
  });

  it('marks a card partial when payment category covers part of the balance', async () => {
    // owes $1,500, payment has $500
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse([mockCreditCardAccount]));
    mockClient.getBudgetMonth.mockResolvedValue(monthWithPaymentBalance(500000));

    const result = JSON.parse(await handleCreditCardStatus({}, mockClient as never));

    expect(result.credit_cards[0].status).toBe('partial');
    expect(result.status).toBe('some_covered');
  });

  it('treats an overpaid (positive balance) card as covered', async () => {
    const overpaid = { ...mockCreditCardAccount, balance: 50000, cleared_balance: 50000, uncleared_balance: 0 };
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse([overpaid]));
    mockClient.getBudgetMonth.mockResolvedValue(monthWithPaymentBalance(0));

    const result = JSON.parse(await handleCreditCardStatus({}, mockClient as never));

    expect(result.credit_cards[0].status).toBe('covered');
    expect(result.status).toBe('all_covered');
  });
});
