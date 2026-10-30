/**
 * Misc fixtures: user and money-movements responses (ynab v4).
 */

export const mockUser = {
  id: 'user-11111111-1111-1111-1111-111111111111',
};

export function createUserResponse(user = mockUser) {
  return { data: { user } };
}

export interface MockMoneyMovement {
  id: string;
  month?: string;
  moved_at?: string;
  note?: string | null;
  money_movement_group_id?: string;
  from_category_id?: string;
  to_category_id?: string;
  amount: number;
  performed_by_user_id?: string | null;
  amount_formatted?: string;
  amount_currency?: number;
}

export const mockMoneyMovements: MockMoneyMovement[] = [
  {
    id: 'mm-1',
    month: '2024-01-01',
    moved_at: '2024-01-15T10:00:00Z',
    note: 'Cover dining overspend',
    money_movement_group_id: 'mmg-1',
    from_category_id: 'cat-groceries',
    to_category_id: 'cat-dining',
    amount: -50000,
    performed_by_user_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  },
  {
    id: 'mm-2',
    month: '2024-01-01',
    moved_at: '2024-01-20T10:00:00Z',
    note: null,
    from_category_id: 'cat-fun',
    to_category_id: 'cat-savings',
    amount: 25000,
  },
];

export function createMoneyMovementsResponse(
  money_movements: MockMoneyMovement[] = mockMoneyMovements
) {
  return { data: { money_movements, server_knowledge: 12345 } };
}

export interface MockMoneyMovementGroup {
  id: string;
  group_created_at: string;
  month: string;
  note?: string | null;
  performed_by_user_id?: string | null;
}

export const mockMoneyMovementGroups: MockMoneyMovementGroup[] = [
  {
    id: 'mmg-1',
    group_created_at: '2024-01-15T10:00:00Z',
    month: '2024-01-01',
    note: 'January rebalancing',
    performed_by_user_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  },
];

export function createMoneyMovementGroupsResponse(
  money_movement_groups: MockMoneyMovementGroup[] = mockMoneyMovementGroups
) {
  return { data: { money_movement_groups, server_knowledge: 12345 } };
}
