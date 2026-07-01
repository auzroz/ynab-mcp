/**
 * Age of Money Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleAgeOfMoney } from '../../../../src/tools/analytics/age-of-money.js';
import {
  createMockClient,
  createBudgetResponse,
  createAccountsResponse,
  mockBudgetDetail,
  mockBudgetAccounts,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

// Build a budget whose plan.months carry age_of_money values.
function budgetWithMonths(months: Array<{ month: string; age_of_money: number | null }>) {
  return createBudgetResponse({
    ...mockBudgetDetail,
    months: months.map((m) => ({
      month: m.month,
      note: null,
      income: 0,
      budgeted: 0,
      activity: 0,
      to_be_budgeted: 0,
      age_of_money: m.age_of_money,
      deleted: false,
      categories: [],
    })),
  });
}

describe('handleAgeOfMoney', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockBudgetAccounts));
  });

  it('reports excellent when age of money is 30+ (most recent month)', async () => {
    mockClient.getBudgetById.mockResolvedValue(
      budgetWithMonths([
        { month: '2024-01-01', age_of_money: 45 },
        { month: '2023-12-01', age_of_money: 20 },
      ])
    );

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    expect(result.status).toBe('excellent');
    expect(result.age_of_money_raw).toBe(45);
    expect(result.age_of_money).toBe('45 days');
    expect(result.target).toContain('30');
  });

  it('reports good for 21-29 days', async () => {
    mockClient.getBudgetById.mockResolvedValue(
      budgetWithMonths([{ month: '2024-01-01', age_of_money: 25 }])
    );

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    expect(result.status).toBe('good');
  });

  it('reports fair for 14-20 days', async () => {
    mockClient.getBudgetById.mockResolvedValue(
      budgetWithMonths([{ month: '2024-01-01', age_of_money: 15 }])
    );

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    expect(result.status).toBe('fair');
    expect(result.tips_to_improve.length).toBeGreaterThan(0);
  });

  it('reports needs_work below 14 days', async () => {
    mockClient.getBudgetById.mockResolvedValue(
      budgetWithMonths([{ month: '2024-01-01', age_of_money: 5 }])
    );

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    expect(result.status).toBe('needs_work');
  });

  it('reports unknown when age of money is not calculated', async () => {
    mockClient.getBudgetById.mockResolvedValue(
      budgetWithMonths([{ month: '2024-01-01', age_of_money: null }])
    );

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    expect(result.status).toBe('unknown');
    expect(result.age_of_money).toBe('Not calculated yet');
    expect(result.age_of_money_raw).toBeNull();
  });

  it('handles a budget with no months', async () => {
    mockClient.getBudgetById.mockResolvedValue(budgetWithMonths([]));

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    expect(result.status).toBe('unknown');
  });

  it('computes cash on hand from on-budget accounts', async () => {
    mockClient.getBudgetById.mockResolvedValue(
      budgetWithMonths([{ month: '2024-01-01', age_of_money: 30 }])
    );

    const result = JSON.parse(await handleAgeOfMoney({}, mockClient as never));

    // mockBudgetAccounts: checking $2,500 + savings $10,000 + Chase Visa -$1,500 + Amex +$50
    expect(result.context.budget_accounts).toBe(mockBudgetAccounts.length);
    expect(result.context.cash_on_hand).toBeDefined();
  });
});
