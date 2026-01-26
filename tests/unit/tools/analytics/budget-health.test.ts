/**
 * Budget Health Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBudgetHealth } from '../../../../src/tools/analytics/budget-health.js';
import {
  createMockClient,
  createMonthResponse,
  createCategoriesResponse,
  mockCategoryGroups,
  mockMonthDetail,
  mockOverspentMonth,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleBudgetHealth', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns health assessment for healthy budget', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.health_score).toBeGreaterThanOrEqual(0);
    expect(parsed.health_score).toBeLessThanOrEqual(100);
    expect(parsed.health_status).toMatch(/excellent|good|fair|poor/);
    expect(parsed.key_metrics).toBeDefined();
    expect(parsed.key_metrics.to_be_budgeted).toBeDefined();
    expect(parsed.month_progress).toBeDefined();
    expect(parsed.category_health).toBeInstanceOf(Array);
    expect(parsed.recommendations).toBeInstanceOf(Array);
  });

  it('identifies overspent categories', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Dining Out is overspent by $75 in mock data
    const overspentAlerts = parsed.alerts.filter(
      (a: { type: string }) => a.type === 'overspent_category'
    );
    expect(overspentAlerts.length).toBeGreaterThan(0);

    const diningAlert = overspentAlerts.find(
      (a: { category: string }) => a.category === 'Dining Out'
    );
    expect(diningAlert).toBeDefined();
  });

  it('identifies underfunded goals', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Vacation has goal_under_funded in mock data
    const underfundedAlerts = parsed.alerts.filter(
      (a: { type: string }) => a.type === 'underfunded_goal'
    );
    expect(underfundedAlerts.length).toBeGreaterThan(0);
  });

  it('detects overbudgeted month', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockOverspentMonth));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Should have critical alert for overbudgeted
    const overbudgetedAlert = parsed.alerts.find(
      (a: { type: string }) => a.type === 'overbudgeted'
    );
    expect(overbudgetedAlert).toBeDefined();
    expect(overbudgetedAlert.severity).toBe('critical');
    expect(parsed.health_score).toBeLessThan(80); // Score should be reduced
  });

  it('reports unbudgeted funds', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Mock month has $500 to_be_budgeted
    const unbudgetedAlert = parsed.alerts.find(
      (a: { type: string }) => a.type === 'unbudgeted_funds'
    );
    expect(unbudgetedAlert).toBeDefined();
    expect(unbudgetedAlert.severity).toBe('info');
  });

  it('calculates month progress correctly', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.month_progress.days_remaining).toBeGreaterThanOrEqual(0);
    expect(parsed.month_progress.percent_complete).toBeGreaterThanOrEqual(0);
    expect(parsed.month_progress.percent_complete).toBeLessThanOrEqual(100);
    expect(parsed.month_progress.daily_budget_remaining).toBeDefined();
  });

  it('generates appropriate recommendations', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockOverspentMonth));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.recommendations.length).toBeGreaterThan(0);
    // Should recommend addressing critical issues
    const criticalRec = parsed.recommendations.find((r: string) =>
      r.toLowerCase().includes('critical')
    );
    expect(criticalRec).toBeDefined();
  });

  it('respects budget_id parameter', async () => {
    const customBudgetId = 'custom-budget-id';
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockMonthDetail));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    await handleBudgetHealth({ budget_id: customBudgetId }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith(customBudgetId);
  });

  it('sorts alerts by severity', async () => {
    mockClient.getBudgetMonth.mockResolvedValue(createMonthResponse(mockOverspentMonth));
    mockClient.getCategories.mockResolvedValue(createCategoriesResponse(mockCategoryGroups));

    const result = await handleBudgetHealth({}, mockClient as never);
    const parsed = JSON.parse(result);

    // Critical should come before warning, warning before info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    let lastSeverity = -1;
    for (const alert of parsed.alerts) {
      const currentSeverity = severityOrder[alert.severity as keyof typeof severityOrder];
      expect(currentSeverity).toBeGreaterThanOrEqual(lastSeverity);
      lastSeverity = currentSeverity;
    }
  });
});
