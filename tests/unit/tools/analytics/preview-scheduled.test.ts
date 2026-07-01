/**
 * Preview Scheduled Transaction Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handlePreviewScheduledTransaction } from '../../../../src/tools/analytics/preview-scheduled.js';
import {
  createMockClient,
  createAccountResponse,
  createCategoryResponse,
  createPayeeResponse,
  mockCheckingAccount,
  mockBillsCategories,
  mockPayees,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const CATEGORY_ID = '22222222-2222-2222-2222-222222222222';
const PAYEE_ID = '33333333-3333-3333-3333-333333333333';
const FUTURE_DATE = '2026-09-01';

describe('handlePreviewScheduledTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T12:00:00Z'));
    mockClient = createMockClient();
    mockClient.getAccountById.mockResolvedValue(createAccountResponse(mockCheckingAccount));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a valid monthly preview with payee_name', async () => {
    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -50,
          frequency: 'monthly',
          payee_name: 'Netflix',
          start_date: FUTURE_DATE,
        },
        mockClient as never
      )
    );

    expect(result.valid).toBe(true);
    expect(result.preview.account_name).toBe('Primary Checking');
    expect(result.preview.payee_name).toBe('Netflix');
    expect(result.preview.frequency_display).toBe('Monthly');
    expect(result.preview.start_date).toBe(FUTURE_DATE);
    expect(result.preview.next_occurrences.length).toBe(3);
    expect(result.api_payload.amount).toBe(-50000);
    expect(result.api_payload.frequency).toBe('monthly');
    expect(result.estimated_costs.monthly).toBeDefined();
    expect(result.estimated_costs.annual).toBeDefined();
  });

  it('computes annual cost for a yearly subscription', async () => {
    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -120,
          frequency: 'yearly',
          payee_name: 'Insurance',
          start_date: FUTURE_DATE,
        },
        mockClient as never
      )
    );

    // yearly: monthly = amount/12, annual = amount
    expect(result.estimated_costs.annual).toBe('$120.00');
    expect(result.preview.frequency_display).toBe('Yearly');
  });

  it('treats "never" frequency as one-time with a single occurrence', async () => {
    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -200,
          frequency: 'never',
          payee_name: 'One Time Purchase',
          start_date: FUTURE_DATE,
        },
        mockClient as never
      )
    );

    expect(result.preview.frequency_display).toBe('One-time');
    expect(result.preview.next_occurrences).toEqual([FUTURE_DATE]);
    expect(result.estimated_costs.monthly).toBe('$0.00');
    expect(result.estimated_costs.annual).toBe('$200.00');
  });

  it('resolves category and payee names by id', async () => {
    mockClient.getCategoryById.mockResolvedValue(createCategoryResponse(mockBillsCategories[0]!));
    mockClient.getPayeeById.mockResolvedValue(createPayeeResponse(mockPayees[0]!));

    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -75,
          frequency: 'monthly',
          payee_id: PAYEE_ID,
          category_id: CATEGORY_ID,
          start_date: FUTURE_DATE,
        },
        mockClient as never
      )
    );

    expect(result.valid).toBe(true);
    expect(result.preview.category_name).toBe(mockBillsCategories[0]!.name);
    expect(result.preview.payee_name).toBe(mockPayees[0]!.name);
    expect(result.api_payload.payee_id).toBe(PAYEE_ID);
    expect(result.api_payload.category_id).toBe(CATEGORY_ID);
  });

  it('records a validation error when the account is not found', async () => {
    mockClient.getAccountById.mockRejectedValue(new Error('404'));

    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -50,
          frequency: 'monthly',
          payee_name: 'Netflix',
          start_date: FUTURE_DATE,
        },
        mockClient as never
      )
    );

    expect(result.valid).toBe(false);
    expect(result.validation_errors).toContain('Account not found');
  });

  it('records a validation error when category or payee lookup fails', async () => {
    mockClient.getCategoryById.mockRejectedValue(new Error('404'));
    mockClient.getPayeeById.mockRejectedValue(new Error('404'));

    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -50,
          frequency: 'monthly',
          payee_id: PAYEE_ID,
          category_id: CATEGORY_ID,
          start_date: FUTURE_DATE,
        },
        mockClient as never
      )
    );

    expect(result.valid).toBe(false);
    expect(result.validation_errors).toContain('Category not found');
    expect(result.validation_errors).toContain('Payee not found');
  });

  it('flags a past start_date as a date validation error', async () => {
    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -50,
          frequency: 'monthly',
          payee_name: 'Netflix',
          start_date: '2020-01-01',
        },
        mockClient as never
      )
    );

    expect(result.valid).toBe(false);
    expect(result.validation_errors).toContain('Date must be in the future');
  });

  it('defaults the start date based on frequency when omitted', async () => {
    const result = JSON.parse(
      await handlePreviewScheduledTransaction(
        {
          account_id: ACCOUNT_ID,
          amount: -50,
          frequency: 'monthly',
          payee_name: 'Netflix',
        },
        mockClient as never
      )
    );

    // monthly default = today + 1 month from 2026-06-30 => 2026-07-30
    expect(result.preview.start_date).toBe('2026-07-30');
    expect(result.valid).toBe(true);
  });

  it('rejects input missing both payee_id and payee_name (schema refine)', async () => {
    await expect(
      handlePreviewScheduledTransaction(
        { account_id: ACCOUNT_ID, amount: -50, frequency: 'monthly', start_date: FUTURE_DATE },
        mockClient as never
      )
    ).rejects.toThrow();
  });
});
