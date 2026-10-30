/**
 * Move Money Tool Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { moveMoneyTool, handleMoveMoney } from '../../../../src/tools/categories/move-money.js';
import { AuditLog } from '../../../../src/services/audit-log.js';
import { YnabApiError } from '../../../../src/utils/errors.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const FROM = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MONTH = '2024-03-01';

function category(id: string, name: string, budgeted: number, balance: number) {
  return { data: { category: { id, name, budgeted, activity: 0, balance } } };
}

describe('handleMoveMoney', () => {
  let mockClient: MockClient;
  let auditLog: AuditLog;

  beforeEach(() => {
    mockClient = createMockClient();
    auditLog = new AuditLog();
    Object.assign(mockClient, { getAuditLog: vi.fn(() => auditLog) });
    mockClient.getMonthCategoryById.mockImplementation(
      async (_b: string, _m: string, id: string) =>
        id === FROM ? category(FROM, 'Dining Out', 200000, 150000) : category(TO, 'Groceries', 300000, 100000)
    );
  });

  const args = { month: MONTH, from_category_id: FROM, to_category_id: TO, amount: 50 };

  it('subtracts from the source and adds to the target, in milliunits', async () => {
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, 100000))
      .mockResolvedValueOnce(category(TO, 'Groceries', 350000, 150000));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(mockClient.updateMonthCategory).toHaveBeenNthCalledWith(1, 'test-budget-id', MONTH, FROM, {
      category: { budgeted: 150000 },
    });
    expect(mockClient.updateMonthCategory).toHaveBeenNthCalledWith(2, 'test-budget-id', MONTH, TO, {
      category: { budgeted: 350000 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.amount).toBe('$50.00');
    expect(parsed.from.budgeted_before).toBe('$200.00');
    expect(parsed.from.budgeted_after).toBe('$150.00');
    expect(parsed.to.budgeted_after).toBe('$350.00');
    expect(parsed.note).toContain('no YNAB money-movement record');
    expect(parsed.warnings).toBeUndefined();
  });

  it('handles fractional amounts without float drift', async () => {
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 0, 0))
      .mockResolvedValueOnce(category(TO, 'Groceries', 0, 0));

    await handleMoveMoney({ ...args, amount: 0.1 + 0.2 }, mockClient as never);

    expect(mockClient.updateMonthCategory.mock.calls[0]?.[3]).toEqual({ category: { budgeted: 199700 } });
    expect(mockClient.updateMonthCategory.mock.calls[1]?.[3]).toEqual({ category: { budgeted: 300300 } });
  });

  it('resolves month "current" to the first of the UTC month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-05-17T12:00:00Z'));
    try {
      mockClient.updateMonthCategory
        .mockResolvedValueOnce(category(FROM, 'Dining Out', 0, 0))
        .mockResolvedValueOnce(category(TO, 'Groceries', 0, 0));

      const parsed = JSON.parse(await handleMoveMoney({ ...args, month: 'current' }, mockClient as never));

      expect(parsed.month).toBe('2024-05-01');
      expect(mockClient.getMonthCategoryById).toHaveBeenCalledWith('test-budget-id', '2024-05-01', FROM);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns when the source category ends up overspent', async () => {
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, -20000))
      .mockResolvedValueOnce(category(TO, 'Groceries', 350000, 150000));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('Dining Out');
  });

  it('adds one move_money summary audit entry without names or amounts text (the per-leg update entries come from the client)', async () => {
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, 0))
      .mockResolvedValueOnce(category(TO, 'Groceries', 350000, 0));

    await handleMoveMoney(args, mockClient as never);

    const entries = auditLog.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: 'ynab_move_money',
      success: true,
      resourceId: FROM,
      details: { month: MONTH, to_category_id: TO, amount_milliunits: 50000, outcome: 'moved' },
    });
    expect(JSON.stringify(entries[0])).not.toContain('Dining');
  });

  it('rolls back the first update when the second fails and says so', async () => {
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, 0))
      .mockRejectedValueOnce(new YnabApiError('Not found', '404'))
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 200000, 150000));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(mockClient.updateMonthCategory).toHaveBeenCalledTimes(3);
    expect(mockClient.updateMonthCategory).toHaveBeenNthCalledWith(3, 'test-budget-id', MONTH, FROM, {
      category: { budgeted: 200000 },
    });
    expect(parsed.error).toBe(true);
    expect(parsed.success).toBe(false);
    expect(parsed.rolled_back).toBe(true);
    expect(parsed.type).toBe('move_failed_rolled_back');
    expect(parsed.cause.type).toBe('ynab_api_error');
    expect(auditLog.getAll()[0]?.details['outcome']).toBe('second_update_failed_rolled_back');
  });

  it('reports a partially applied move when the rollback also fails', async () => {
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, 0))
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom again'));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(parsed.rolled_back).toBe(false);
    expect(parsed.type).toBe('move_partially_applied');
    expect(parsed.message).toContain('$150.00');
    expect(parsed.message).toContain('ynab_update_category');
    expect(parsed.from.original_budgeted_milliunits).toBe(200000);
    expect(parsed.cause.error).toBe(true);
    expect(auditLog.getAll()[0]?.success).toBe(false);
  });

  it('rejects the same UUID in different case without writing', async () => {
    await expect(
      handleMoveMoney({ ...args, from_category_id: FROM, to_category_id: FROM.toUpperCase() }, mockClient as never)
    ).rejects.toThrow();
    expect(mockClient.updateMonthCategory).not.toHaveBeenCalled();
  });

  it('refuses before any write when both reads resolve to the same category', async () => {
    mockClient.getMonthCategoryById.mockImplementation(async () =>
      category(FROM, 'Dining Out', 200000, 150000)
    );

    await expect(handleMoveMoney(args, mockClient as never)).rejects.toThrow('must be different');
    expect(mockClient.updateMonthCategory).not.toHaveBeenCalled();
  });

  it('refuses internal categories (flag or Internal Master Category group) without writing', async () => {
    for (const [side, extra] of [
      ['from', { internal: true }],
      ['to', { category_group_name: 'Internal Master Category' }],
    ] as const) {
      mockClient.getMonthCategoryById.mockImplementation(async (_b: string, _m: string, id: string) => {
        const base = id === FROM ? category(FROM, 'A', 1000, 1000) : category(TO, 'B', 1000, 1000);
        const isTarget = (side === 'from' && id === FROM) || (side === 'to' && id === TO);
        return isTarget ? { data: { category: { ...base.data.category, ...extra } } } : base;
      });
      await expect(handleMoveMoney(args, mockClient as never)).rejects.toThrow('ynab_update_category');
    }
    expect(mockClient.updateMonthCategory).not.toHaveBeenCalled();
    expect(moveMoneyTool.description).toContain('Ready to Assign');
  });

  it('treats a leg-2 error as success when the re-read shows the write landed', async () => {
    mockClient.getMonthCategoryById
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 200000, 150000))
      .mockResolvedValueOnce(category(TO, 'Groceries', 300000, 100000))
      .mockResolvedValueOnce(category(TO, 'Groceries', 350000, 150000));
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, 100000))
      .mockRejectedValueOnce(new Error('socket hang up'));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(parsed.success).toBe(true);
    expect(parsed.to.budgeted_after).toBe('$350.00');
    expect(parsed.warnings[0]).toContain('confirmed applied');
    expect(mockClient.updateMonthCategory).toHaveBeenCalledTimes(2);
    expect(auditLog.getAll()[0]?.success).toBe(true);
  });

  it('reports an uncertain outcome and does not roll back when the re-read fails', async () => {
    mockClient.getMonthCategoryById
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 200000, 150000))
      .mockResolvedValueOnce(category(TO, 'Groceries', 300000, 100000))
      .mockRejectedValueOnce(new Error('offline'));
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Dining Out', 150000, 100000))
      .mockRejectedValueOnce(new Error('timeout'));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(parsed.success).toBe(false);
    expect(parsed.type).toBe('move_outcome_uncertain');
    expect(parsed.rolled_back).toBe(false);
    expect(parsed.from.original_budgeted_milliunits).toBe(200000);
    expect(parsed.to.original_budgeted_milliunits).toBe(300000);
    expect(parsed.message).toContain('Could not confirm');
    expect(mockClient.updateMonthCategory).toHaveBeenCalledTimes(2);
  });

  it('throws without a second update when the first update fails', async () => {
    mockClient.updateMonthCategory.mockRejectedValueOnce(new Error('nope'));

    await expect(handleMoveMoney(args, mockClient as never)).rejects.toThrow('nope');
    expect(mockClient.updateMonthCategory).toHaveBeenCalledTimes(1);
  });

  it('does not write when a category lookup fails', async () => {
    mockClient.getMonthCategoryById.mockRejectedValueOnce(new Error('missing'));

    await expect(handleMoveMoney(args, mockClient as never)).rejects.toThrow('missing');
    expect(mockClient.updateMonthCategory).not.toHaveBeenCalled();
  });

  it('rejects identical categories, non-positive or sub-milliunit amounts, and bad months', async () => {
    const bad = [
      { ...args, to_category_id: FROM },
      { ...args, amount: 0 },
      { ...args, amount: -5 },
      { ...args, amount: 0.0001 },
      { ...args, amount: Number.POSITIVE_INFINITY },
      { ...args, month: '2024-03-15' },
      { ...args, from_category_id: 'not-a-uuid' },
    ];
    for (const input of bad) {
      await expect(handleMoveMoney(input, mockClient as never)).rejects.toThrow();
    }
    expect(mockClient.updateMonthCategory).not.toHaveBeenCalled();
  });

  it('sanitizes category names in output', async () => {
    mockClient.getMonthCategoryById.mockImplementation(async (_b: string, _m: string, id: string) =>
      category(id, 'Fun\u0000 Money', 1000, 1000)
    );
    mockClient.updateMonthCategory
      .mockResolvedValueOnce(category(FROM, 'Fun Money', 0, 0))
      .mockResolvedValueOnce(category(TO, 'Fun Money', 0, 0));

    const parsed = JSON.parse(await handleMoveMoney(args, mockClient as never));

    expect(parsed.from.name).toBe('Fun Money');
  });

  it('describes the non-atomic, budgeted-only behavior and bounds string inputs', () => {
    expect(moveMoneyTool.description).toContain('money-movement record');
    expect(moveMoneyTool.description).toContain('Use when the user asks');
    expect(moveMoneyTool.inputSchema.required).toEqual([
      'month',
      'from_category_id',
      'to_category_id',
      'amount',
    ]);
  });
});
