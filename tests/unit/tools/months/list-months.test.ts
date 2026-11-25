/**
 * List Months Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListMonths as rawHandleListMonths, listMonthsOutputSchema } from '../../../../src/tools/months/list-months.js';
import { validating } from '../output-validation.js';
import {
  createMockClient,
  createMonthsResponse,
  mockMonthSummaries,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleListMonths = validating(listMonthsOutputSchema, rawHandleListMonths);

describe('handleListMonths', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists months with formatted amounts and count', async () => {
    mockClient.getBudgetMonths.mockResolvedValue(createMonthsResponse());

    const parsed = await handleListMonths({}, mockClient as never);

    expect(parsed.count).toBe(mockMonthSummaries.length);
    expect(parsed.months[0].month).toBe('2024-01-01');
    expect(parsed.months[0].income).toContain('$');
    expect(parsed.months[0].budgeted).toContain('$');
    expect(parsed.months[0].activity).toContain('$');
    expect(parsed.months[0].to_be_budgeted).toContain('$');
    expect(parsed.months[0].age_of_money).toBe(45);
  });

  it('handles months with null notes', async () => {
    mockClient.getBudgetMonths.mockResolvedValue(createMonthsResponse());

    const parsed = await handleListMonths({}, mockClient as never);

    const octMonth = parsed.months.find((m: { month: string }) => m.month === '2023-10-01');
    expect(octMonth.note).toBeNull();
  });

  it('resolves custom budget_id', async () => {
    mockClient.getBudgetMonths.mockResolvedValue(createMonthsResponse([]));

    await handleListMonths({ budget_id: 'b-2' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-2');
    expect(mockClient.getBudgetMonths).toHaveBeenCalledWith('b-2');
  });

  it('handles empty month list', async () => {
    mockClient.getBudgetMonths.mockResolvedValue(createMonthsResponse([]));

    const parsed = await handleListMonths({}, mockClient as never);

    expect(parsed.count).toBe(0);
    expect(parsed.months).toEqual([]);
  });
});
