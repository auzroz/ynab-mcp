/**
 * List Money Movements Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListMoneyMovements } from '../../../../src/tools/money-movements/list-money-movements.js';
import {
  createMockClient,
  createMoneyMovementsResponse,
  createMoneyMovementGroupsResponse,
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

  it('adds raw milliunit amounts and a masked performed_by_user_id', async () => {
    mockClient.getMoneyMovements.mockResolvedValue(createMoneyMovementsResponse());

    const parsed = JSON.parse(await handleListMoneyMovements({}, mockClient as never));

    expect(parsed.money_movements[0].amount).toBe('-$50.00');
    expect(parsed.money_movements[0].amount_milliunits).toBe(-50000);
    expect(parsed.money_movements[1].amount_milliunits).toBe(25000);
    expect(parsed.money_movements[0].performed_by_user_id).toBe('3f25...3301');
    expect(parsed.money_movements[1].performed_by_user_id).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('3f2504e0-4f89');
  });

  describe('group_by_group', () => {
    const movements = [
      { id: 'a', amount: 1000, money_movement_group_id: 'g1', month: '2024-01-01' },
      { id: 'b', amount: -1000, money_movement_group_id: 'g1', month: '2024-01-01' },
      { id: 'c', amount: 5000, money_movement_group_id: 'g-missing', month: '2024-01-01' },
      { id: 'd', amount: 7000 },
    ];
    const groups = [
      { id: 'g1', month: '2024-01-01', group_created_at: '2024-01-02T00:00:00Z', note: 'Batch', performed_by_user_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { id: 'g-empty', month: '2024-01-01', group_created_at: '2024-01-03T00:00:00Z', note: null },
    ];

    it('nests movements under their group, with ungrouped ones and unknown groups kept', async () => {
      mockClient.getMoneyMovements.mockResolvedValue(createMoneyMovementsResponse(movements));
      mockClient.getMoneyMovementGroups.mockResolvedValue(createMoneyMovementGroupsResponse(groups));

      const parsed = JSON.parse(
        await handleListMoneyMovements({ group_by_group: true }, mockClient as never)
      );

      expect(mockClient.getMoneyMovementGroups).toHaveBeenCalledTimes(1);
      expect(parsed.money_movements).toBeUndefined();
      expect(parsed.count).toBe(4);
      expect(parsed.group_count).toBe(2);
      const [g1, missing] = parsed.money_movement_groups;
      expect(g1).toMatchObject({ id: 'g1', note: 'Batch', count: 2, performed_by_user_id: '3f25...3301' });
      expect(g1.movements.map((m: { id: string }) => m.id)).toEqual(['a', 'b']);
      expect(g1.movements[1].amount_milliunits).toBe(-1000);
      expect(missing).toMatchObject({ id: 'g-missing', group_created_at: null, note: null, count: 1 });
      expect(parsed.ungrouped_movements.map((m: { id: string }) => m.id)).toEqual(['d']);
    });

    it('uses the month endpoints for both requests when month is given', async () => {
      mockClient.getMoneyMovementsByMonth.mockResolvedValue(createMoneyMovementsResponse(movements));
      mockClient.getMoneyMovementGroupsByMonth.mockResolvedValue(createMoneyMovementGroupsResponse(groups));

      const parsed = JSON.parse(
        await handleListMoneyMovements(
          { budget_id: 'b-1', month: '2024-01-01', group_by_group: true },
          mockClient as never
        )
      );

      expect(mockClient.getMoneyMovementGroupsByMonth).toHaveBeenCalledWith('b-1', '2024-01-01');
      expect(mockClient.getMoneyMovementGroups).not.toHaveBeenCalled();
      expect(parsed.month).toBe('2024-01-01');
    });

    it('does not fetch groups when group_by_group is false or omitted', async () => {
      mockClient.getMoneyMovements.mockResolvedValue(createMoneyMovementsResponse(movements));

      await handleListMoneyMovements({ group_by_group: false }, mockClient as never);
      await handleListMoneyMovements({}, mockClient as never);

      expect(mockClient.getMoneyMovementGroups).not.toHaveBeenCalled();
    });
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

  it('uses the month endpoint when month is provided', async () => {
    mockClient.getMoneyMovementsByMonth.mockResolvedValue(createMoneyMovementsResponse());

    const parsed = JSON.parse(
      await handleListMoneyMovements({ month: '2024-01-01' }, mockClient as never)
    );

    expect(mockClient.getMoneyMovementsByMonth).toHaveBeenCalledWith(expect.any(String), '2024-01-01');
    expect(mockClient.getMoneyMovements).not.toHaveBeenCalled();
    expect(parsed.month).toBe('2024-01-01');
  });

  it('accepts "current" and rejects non-first-of-month values', async () => {
    mockClient.getMoneyMovementsByMonth.mockResolvedValue(createMoneyMovementsResponse([]));
    await handleListMoneyMovements({ month: 'current' }, mockClient as never);
    expect(mockClient.getMoneyMovementsByMonth).toHaveBeenCalledWith(expect.any(String), 'current');

    for (const bad of ['2024-01-15', '2024-13-01', 'January', '2024-02-30']) {
      await expect(
        handleListMoneyMovements({ month: bad }, mockClient as never)
      ).rejects.toThrow();
    }
  });
});
