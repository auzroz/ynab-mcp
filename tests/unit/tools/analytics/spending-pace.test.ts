/**
 * Spending Pace Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSpendingPace } from '../../../../src/tools/analytics/spending-pace.js';
import {
  createMockClient,
  createCategoriesResponse,
  createMonthResponse,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

function monthWith(
  categories: Array<{ id: string; name: string; budgeted: number; activity: number; hidden?: boolean }>
) {
  return createMonthResponse({
    ...mockMonthDetail,
    categories: categories.map((c) => ({
      ...mockMonthDetail.categories[0]!,
      id: c.id,
      name: c.name,
      budgeted: c.budgeted,
      activity: c.activity,
      balance: 0,
      hidden: c.hidden ?? false,
    })),
  });
}

describe('handleSpendingPace', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    // Day 15 of a 31-day month => ~48% elapsed
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    mockClient = createMockClient();
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports overspent when total spent exceeds budget', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-dining-666', name: 'Dining Out', budgeted: 100000, activity: -150000 }])
    );

    const result = JSON.parse(await handleSpendingPace({}, mockClient as never));

    expect(result.status).toBe('overspent');
    expect(result.message).toContain('over budget');
    expect(result.category_status.overspent).toBe(1);
  });

  it('reports behind when daily actual outpaces target', async () => {
    // budgeted $310 (daily target $10), spent $300 over 15 days ($20/day) => behind
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-groceries-555', name: 'Groceries', budgeted: 310000, activity: -300000 }])
    );

    const result = JSON.parse(await handleSpendingPace({}, mockClient as never));

    expect(result.status).toBe('behind');
    expect(result.categories_needing_attention.length).toBeGreaterThan(0);
  });

  it('reports ahead when spending is well below target rate', async () => {
    // budgeted $620 (daily target $20), spent $30 over 15 days ($2/day) => ahead
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-gas-888', name: 'Gas', budgeted: 620000, activity: -30000 }])
    );

    const result = JSON.parse(await handleSpendingPace({}, mockClient as never));

    expect(result.status).toBe('ahead');
    expect(result.categories_ahead.length).toBeGreaterThan(0);
  });

  it('reports on_track when pace matches target', async () => {
    // budgeted $310 (daily target $10), spent $150 over 15 days ($10/day) => on track
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-transport-777', name: 'Transportation', budgeted: 310000, activity: -150000 }])
    );

    const result = JSON.parse(await handleSpendingPace({}, mockClient as never));

    expect(result.status).toBe('on_track');
  });

  it('includes progress metadata for the month', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-groceries-555', name: 'Groceries', budgeted: 310000, activity: -150000 }])
    );

    const result = JSON.parse(await handleSpendingPace({}, mockClient as never));

    expect(result.progress.day_of_month).toBe(15);
    expect(result.progress.days_in_month).toBe(31);
    expect(result.progress.days_remaining).toBe(16);
  });

  it('skips categories with no budget and no spending, and hidden/internal', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([
        { id: 'cat-hobbies-fff', name: 'Hobbies', budgeted: 0, activity: 0 },
        { id: 'cat-hidden-ggg', name: 'Hidden', budgeted: 100000, activity: -50000, hidden: true },
        { id: 'cat-rta-iii', name: 'Inflow: Ready to Assign', budgeted: 100000, activity: -50000 },
      ])
    );

    const result = JSON.parse(await handleSpendingPace({}, mockClient as never));

    const counts = result.category_status;
    expect(counts.overspent + counts.behind + counts.on_track + counts.ahead).toBe(0);
  });
});
