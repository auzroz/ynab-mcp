/**
 * Get Budget Settings Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetBudgetSettings } from '../../../../src/tools/budgets/get-budget-settings.js';
import {
  createMockClient,
  createBudgetSettingsResponse,
  mockEurCurrencyFormat,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleGetBudgetSettings', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns date_format and currency_format', async () => {
    mockClient.getBudgetSettingsById.mockResolvedValue(createBudgetSettingsResponse());

    const result = await handleGetBudgetSettings({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.budget_id).toBe('test-budget-id');
    expect(parsed.settings.date_format).toBe('MM/DD/YYYY');
    expect(parsed.settings.currency_format.iso_code).toBe('USD');
    expect(parsed.settings.currency_format.decimal_digits).toBe(2);
  });

  it('resolves a custom budget_id', async () => {
    mockClient.getBudgetSettingsById.mockResolvedValue(createBudgetSettingsResponse());

    await handleGetBudgetSettings({ budget_id: 'my-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('my-budget');
    expect(mockClient.getBudgetSettingsById).toHaveBeenCalledWith('my-budget');
  });

  it('returns EUR currency format with non-USD date format', async () => {
    mockClient.getBudgetSettingsById.mockResolvedValue(
      createBudgetSettingsResponse(mockEurCurrencyFormat)
    );

    const result = await handleGetBudgetSettings({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.settings.currency_format.iso_code).toBe('EUR');
    expect(parsed.settings.date_format).toBe('DD/MM/YYYY');
  });

  it('returns null currency_format when absent', async () => {
    mockClient.getBudgetSettingsById.mockResolvedValue({
      data: { settings: { date_format: null, currency_format: null } },
    });

    const result = await handleGetBudgetSettings({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.settings.date_format).toBeNull();
    expect(parsed.settings.currency_format).toBeNull();
  });
});
