/**
 * List Money Movements Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListMoneyMovements } from '../../../../src/tools/money-movements/list-money-movements.js';
import {
  createMockClient,
  createMoneyMovementsResponse,
  mockMoneyMovements,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListMoneyMovements', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists money movements with formatted amounts and count', async () => {
    mockClient.getMoneyMovements.mockResolvedValue(createMoneyMovementsResponse());

    const result = await handleListMoneyMovements({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(mockMoneyMovements.length);
    expect(parsed.money_movements[0].id).toBe('mm-1');
    expect(parsed.money_movements[0].amount).toContain('$');
    expect(parsed.money_movements[0].from_category_id).toBe('cat-groceries');
    expect(parsed.money_movements[0].to_category_id).toBe('cat-dining');
    expect(parsed.money_movements[0].money_movement_group_id).toBe('mmg-1');
    expect(parsed.money_movements[0].note).toBe('Cover dining overspend');
  });

  it('coerces missing optional fields to null', async () => {
    mockClient.getMoneyMovements.mockResolvedValue(
      createMoneyMovementsResponse([{ id: 'mm-x', amount: 1000 }])
    );

    const result = await handleListMoneyMovements({}, mockClient as never);
    const parsed = JSON.parse(result);

    const m = parsed.money_movements[0];
    expect(m.month).toBeNull();
    expect(m.moved_at).toBeNull();
    expect(m.from_category_id).toBeNull();
    expect(m.to_category_id).toBeNull();
    expect(m.money_movement_group_id).toBeNull();
    expect(m.note).toBeNull();
  });

  it('resolves custom budget_id', async () => {
    mockClient.getMoneyMovements.mockResolvedValue(createMoneyMovementsResponse([]));

    await handleListMoneyMovements({ budget_id: 'b-12' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-12');
    expect(mockClient.getMoneyMovements).toHaveBeenCalledWith('b-12');
  });

  it('handles empty movements list', async () => {
    mockClient.getMoneyMovements.mockResolvedValue(createMoneyMovementsResponse([]));

    const result = await handleListMoneyMovements({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.money_movements).toEqual([]);
  });
});
