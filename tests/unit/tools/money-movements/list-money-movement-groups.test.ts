/**
 * List Money Movement Groups Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListMoneyMovementGroups } from '../../../../src/tools/money-movements/list-money-movement-groups.js';
import {
  createMockClient,
  createMoneyMovementGroupsResponse,
  mockMoneyMovementGroups,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListMoneyMovementGroups', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists all groups without a month', async () => {
    mockClient.getMoneyMovementGroups.mockResolvedValue(createMoneyMovementGroupsResponse());

    const parsed = JSON.parse(await handleListMoneyMovementGroups({}, mockClient as never));

    expect(parsed.count).toBe(mockMoneyMovementGroups.length);
    expect(parsed.month).toBeNull();
    expect(parsed.money_movement_groups[0]).toEqual({
      id: 'mmg-1',
      month: '2024-01-01',
      group_created_at: '2024-01-15T10:00:00Z',
      note: 'January rebalancing',
      has_performed_by_user: true,
    });
    expect(mockClient.getMoneyMovementGroupsByMonth).not.toHaveBeenCalled();
  });

  it('uses the month endpoint when month is given', async () => {
    mockClient.getMoneyMovementGroupsByMonth.mockResolvedValue(
      createMoneyMovementGroupsResponse([
        { id: 'g2', month: '2024-02-01', group_created_at: '2024-02-02T00:00:00Z', note: null },
      ])
    );

    const parsed = JSON.parse(
      await handleListMoneyMovementGroups({ budget_id: 'b-1', month: '2024-02-01' }, mockClient as never)
    );

    expect(mockClient.getMoneyMovementGroupsByMonth).toHaveBeenCalledWith('b-1', '2024-02-01');
    expect(parsed.month).toBe('2024-02-01');
    expect(parsed.money_movement_groups[0].note).toBeNull();
    expect(parsed.money_movement_groups[0].has_performed_by_user).toBe(false);
  });

  it('rejects an invalid month', async () => {
    await expect(
      handleListMoneyMovementGroups({ month: '2024-02-10' }, mockClient as never)
    ).rejects.toThrow();
  });
});
