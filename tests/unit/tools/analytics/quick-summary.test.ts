/**
 * Quick Summary Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleQuickSummary } from '../../../../src/tools/analytics/quick-summary.js';
import {
  createMockClient,
  createMonthResponse,
  createAccountsResponse,
  mockMonthDetail,
  mockAllAccounts,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleQuickSummary', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns a summary with key metrics and alerts', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleQuickSummary({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toMatch(/healthy|warning|attention_needed/);
    expect(parsed.message).toBeDefined();
    expect(parsed.key_metrics).toBeDefined();
    expect(parsed.key_metrics.ready_to_assign).toBeDefined();
    expect(parsed.key_metrics.spent_this_month).toBeDefined();
    expect(parsed.key_metrics.total_in_budget_accounts).toBeDefined();
    expect(parsed.key_metrics.total_debt).toBeDefined();
    expect(parsed.key_metrics.age_of_money).toBe('45 days');
    expect(parsed.account_summary).toBeDefined();
  });

  it('flags attention_needed when categories are overspent', async () => {
    // mockMonthDetail includes Dining Out (-$75) and Subscriptions (-$15) with negative balance
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleQuickSummary({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('attention_needed');
    expect(parsed.alerts.overspent_categories).not.toBeNull();
    expect(parsed.tips.length).toBeGreaterThan(0);
  });

  it('reports healthy status with no overspending', async () => {
    const healthyCategories = mockMonthDetail.categories.map((c) => ({
      ...c,
      balance: Math.max(c.balance, 50000),
      goal_under_funded: 0,
    }));
    mockClient.getBudgetMonth.mockResolvedValue(
      createMonthResponse({ ...mockMonthDetail, to_be_budgeted: 500000, categories: healthyCategories })
    );
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleQuickSummary({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('healthy');
    expect(parsed.message).toBe('Budget is on track');
    expect(parsed.tips).toEqual([]);
  });

  it('flags attention_needed for negative ready to assign', async () => {
    const noOverspend = mockMonthDetail.categories.map((c) => ({
      ...c,
      balance: Math.max(c.balance, 1000),
      goal_under_funded: 0,
    }));
    mockClient.getBudgetMonth.mockResolvedValue(
      createMonthResponse({ ...mockMonthDetail, to_be_budgeted: -100000, categories: noOverspend })
    );
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleQuickSummary({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe('attention_needed');
    expect(parsed.message).toContain('Ready to Assign is negative');
  });

  it('excludes closed accounts from summary', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    const result = await handleQuickSummary({}, mockClient as never);
    const parsed = JSON.parse(result);

    const cashNames = parsed.account_summary.checking_savings.map(
      (a: { name: string }) => a.name
    );
    expect(cashNames).not.toContain('Old Savings');
  });

  it('respects budget_id parameter', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getAccounts.mockResolvedValue(createAccountsResponse(mockAllAccounts));

    await handleQuickSummary({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
