/**
 * List Payees Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListPayees as rawHandleListPayees, listPayeesOutputSchema } from '../../../../src/tools/payees/list-payees.js';
import { validating } from '../output-validation.js';
import {
  createMockClient,
  createPayeesResponse,
  mockAllPayees,
  mockPayees,
  mockTransferPayees,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleListPayees = validating(listPayeesOutputSchema, rawHandleListPayees);

describe('handleListPayees', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('separates regular and transfer payees, excludes deleted', async () => {
    mockClient.getPayees.mockResolvedValue(createPayeesResponse(mockAllPayees));

    const parsed = await handleListPayees({}, mockClient as never);

    // Deleted payee excluded
    expect(parsed.summary.total_payees).toBe(mockPayees.length + mockTransferPayees.length);
    expect(parsed.summary.regular_payees).toBe(mockPayees.length);
    expect(parsed.summary.transfer_payees).toBe(mockTransferPayees.length);
    expect(parsed.payees.every((p: { transfer_account_id: null }) => p.transfer_account_id === null)).toBe(true);
    expect(parsed.transfer_payees.every((p: { transfer_account_id: string }) => p.transfer_account_id !== null)).toBe(true);
  });

  it('sorts payees by name', async () => {
    mockClient.getPayees.mockResolvedValue(createPayeesResponse(mockPayees));

    const parsed = await handleListPayees({}, mockClient as never);

    const names = parsed.payees.map((p: { name: string }) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('resolves custom budget_id', async () => {
    mockClient.getPayees.mockResolvedValue(createPayeesResponse([]));

    await handleListPayees({ budget_id: 'b-4' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-4');
    expect(mockClient.getPayees).toHaveBeenCalledWith('b-4');
  });

  it('handles empty payee list', async () => {
    mockClient.getPayees.mockResolvedValue(createPayeesResponse([]));

    const parsed = await handleListPayees({}, mockClient as never);

    expect(parsed.summary.total_payees).toBe(0);
    expect(parsed.payees).toEqual([]);
    expect(parsed.transfer_payees).toEqual([]);
  });
});
