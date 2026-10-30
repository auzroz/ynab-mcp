/**
 * Get Budget Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetBudget } from '../../../../src/tools/budgets/get-budget.js';
import {
  createMockClient,
  createBudgetResponse,
  mockBudgetDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleGetBudget', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns budget details with summary and accounts_by_type', async () => {
    mockClient.getBudgetById.mockResolvedValue(createBudgetResponse());

    const result = await handleGetBudget({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.budget_id).toBe(mockBudgetDetail.id);
    expect(parsed.name).toBe('My Budget');
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total_assets).toBeDefined();
    expect(parsed.summary.total_liabilities).toBeDefined();
    expect(parsed.summary.net_worth).toBeDefined();
    expect(parsed.summary.account_count).toBeGreaterThan(0);
    expect(parsed.accounts_by_type).toBeDefined();
    // Closed accounts excluded; checking present
    expect(parsed.accounts_by_type.checking).toBeDefined();
    expect(parsed.accounts_by_type.savings).toBeDefined();
  });

  it('resolves budget_id and fetches the full budget', async () => {
    mockClient.getBudgetById.mockResolvedValue(createBudgetResponse());

    await handleGetBudget({ budget_id: 'custom-id' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-id');
    expect(mockClient.getBudgetById).toHaveBeenCalledWith('custom-id');
  });

  it('never sends a delta cursor, since the totals need the whole budget', async () => {
    mockClient.getServerKnowledge.mockReturnValue(999);
    mockClient.getBudgetById.mockResolvedValue(createBudgetResponse());

    await handleGetBudget({}, mockClient as never);
    await handleGetBudget({}, mockClient as never);

    expect(mockClient.getBudgetById.mock.calls).toEqual([['test-budget-id'], ['test-budget-id']]);
    expect(mockClient.getServerKnowledge).not.toHaveBeenCalled();
  });

  it('builds category_groups excluding hidden and Internal Master Category', async () => {
    mockClient.getBudgetById.mockResolvedValue(createBudgetResponse());

    const result = await handleGetBudget({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.category_groups).toBeInstanceOf(Array);
    const names = parsed.category_groups.map((g: { name: string }) => g.name);
    expect(names).not.toContain('Internal Master Category');
  });

  it('handles budget with no currency_format using default formatting', async () => {
    const noCurrency = { ...mockBudgetDetail, currency_format: null };
    mockClient.getBudgetById.mockResolvedValue(createBudgetResponse(noCurrency as never));

    const result = await handleGetBudget({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.summary.total_assets).toContain('$');
  });

  it('includes month range, date format and account ids', async () => {
    mockClient.getBudgetById.mockResolvedValue(createBudgetResponse());

    const result = await handleGetBudget({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.first_month).toBe('2023-01-01');
    expect(parsed.last_month).toBe('2024-12-01');
    expect(parsed.date_format).toEqual({ format: 'MM/DD/YYYY' });
    const checking = parsed.accounts_by_type.checking[0];
    expect(checking.id).toEqual(expect.any(String));
    expect(checking.name).toBe('Primary Checking');
  });
});
