/**
 * Overspending Alerts Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleOverspendingAlerts } from '../../../../src/tools/analytics/overspending-alerts.js';
import {
  createMockClient,
  createCategoriesResponse,
  createMonthResponse,
  mockMonthDetail,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

function monthWith(
  categories: Array<{ id: string; name: string; balance: number; budgeted: number; activity: number; hidden?: boolean }>
) {
  return createMonthResponse({
    ...mockMonthDetail,
    categories: categories.map((c) => ({
      ...mockMonthDetail.categories[0]!,
      id: c.id,
      name: c.name,
      balance: c.balance,
      budgeted: c.budgeted,
      activity: c.activity,
      hidden: c.hidden ?? false,
    })),
  });
}

describe('handleOverspendingAlerts', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    mockClient = createMockClient();
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports all_clear when no categories are overspent', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-groceries-555', name: 'Groceries', balance: 100000, budgeted: 600000, activity: -500000 }])
    );

    const result = JSON.parse(await handleOverspendingAlerts({}, mockClient as never));

    expect(result.status).toBe('all_clear');
    expect(result.summary.overspent_categories).toBe(0);
    expect(result.suggestions).toEqual([]);
  });

  it('reports minor_overspend when total under $50', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([{ id: 'cat-subscriptions-ddd', name: 'Subscriptions', balance: -15000, budgeted: 50000, activity: -65000 }])
    );

    const result = JSON.parse(await handleOverspendingAlerts({}, mockClient as never));

    expect(result.status).toBe('minor_overspend');
    expect(result.summary.overspent_categories).toBe(1);
    expect(result.alerts[0].category).toBe('Subscriptions');
  });

  it('reports significant_overspend when total at or over $50', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([
        { id: 'cat-dining-666', name: 'Dining Out', balance: -75000, budgeted: 200000, activity: -275000 },
      ])
    );

    const result = JSON.parse(await handleOverspendingAlerts({}, mockClient as never));

    expect(result.status).toBe('significant_overspend');
    expect(result.summary.overspent_categories).toBe(1);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('sorts alerts by overspent amount descending and groups them', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([
        { id: 'cat-subscriptions-ddd', name: 'Subscriptions', balance: -15000, budgeted: 50000, activity: -65000 },
        { id: 'cat-dining-666', name: 'Dining Out', balance: -75000, budgeted: 200000, activity: -275000 },
      ])
    );

    const result = JSON.parse(await handleOverspendingAlerts({}, mockClient as never));

    expect(result.alerts[0].category).toBe('Dining Out'); // larger overspend first
    expect(result.by_group.length).toBeGreaterThan(0);
  });

  it('respects the threshold argument (in dollars)', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([
        { id: 'cat-subscriptions-ddd', name: 'Subscriptions', balance: -15000, budgeted: 50000, activity: -65000 },
        { id: 'cat-dining-666', name: 'Dining Out', balance: -75000, budgeted: 200000, activity: -275000 },
      ])
    );

    // threshold $50 => only the $75 overspend qualifies
    const result = JSON.parse(
      await handleOverspendingAlerts({ threshold: 50 }, mockClient as never)
    );

    expect(result.summary.overspent_categories).toBe(1);
    expect(result.alerts[0].category).toBe('Dining Out');
  });

  it('skips hidden and internal categories', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(
      monthWith([
        { id: 'cat-hidden-ggg', name: 'Hidden', balance: -100000, budgeted: 0, activity: -100000, hidden: true },
        { id: 'cat-rta-iii', name: 'Inflow: Ready to Assign', balance: -100000, budgeted: 0, activity: -100000 },
      ])
    );

    const result = JSON.parse(await handleOverspendingAlerts({}, mockClient as never));

    expect(result.status).toBe('all_clear');
  });
});
