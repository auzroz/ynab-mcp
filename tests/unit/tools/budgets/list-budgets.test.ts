/**
 * List Budgets Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListBudgets } from '../../../../src/tools/budgets/list-budgets.js';
import {
  createMockClient,
  createBudgetsResponse,
  mockBudgetSummary,
  mockEurBudgetSummary,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListBudgets', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists budgets with names, ids, and count', async () => {
    mockClient.getBudgets.mockResolvedValue(createBudgetsResponse());

    const result = await handleListBudgets({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(2);
    expect(parsed.budgets).toHaveLength(2);
    expect(parsed.budgets[0].id).toBe(mockBudgetSummary.id);
    expect(parsed.budgets[0].name).toBe('My Budget');
    expect(parsed.budgets[0].last_modified).toBe(mockBudgetSummary.last_modified_on);
    expect(parsed.default_budget_id).toBe('test-budget-id');
  });

  it('includes sanitized currency_format when present', async () => {
    mockClient.getBudgets.mockResolvedValue(createBudgetsResponse([mockBudgetSummary]));

    const result = await handleListBudgets({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.budgets[0].currency_format.iso_code).toBe('USD');
    expect(parsed.budgets[0].currency_format.decimal_digits).toBe(2);
  });

  it('passes include_accounts=false to client by default', async () => {
    mockClient.getBudgets.mockResolvedValue(createBudgetsResponse());

    await handleListBudgets({}, mockClient as never);

    expect(mockClient.getBudgets).toHaveBeenCalledWith(false);
  });

  it('passes include_accounts=true and embeds account summaries', async () => {
    // mockBudgetSummary has accounts populated; EUR budget has empty accounts.
    mockClient.getBudgets.mockResolvedValue(createBudgetsResponse([mockBudgetSummary]));

    const result = await handleListBudgets({ include_accounts: true }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(mockClient.getBudgets).toHaveBeenCalledWith(true);
    expect(parsed.budgets[0].accounts).toBeInstanceOf(Array);
    expect(parsed.budgets[0].accounts.length).toBeGreaterThan(0);
    expect(parsed.budgets[0].accounts[0]).toHaveProperty('name');
    expect(parsed.budgets[0].accounts[0]).toHaveProperty('balance');
    expect(parsed.budgets[0].accounts[0]).toHaveProperty('closed');
  });

  it('omits accounts for budgets with empty account list', async () => {
    mockClient.getBudgets.mockResolvedValue(createBudgetsResponse([mockEurBudgetSummary]));

    const result = await handleListBudgets({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.budgets[0].accounts).toBeUndefined();
  });

  it('handles empty budget list', async () => {
    mockClient.getBudgets.mockResolvedValue(createBudgetsResponse([]));

    const result = await handleListBudgets({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.budgets).toEqual([]);
  });
});
