/**
 * Update Transaction Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { handleUpdateTransaction, updateTransactionTool } from '../../../../src/tools/transactions/update-transaction.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const TXN_ID = '99999999-9999-9999-9999-999999999999';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';

function updatedTxnResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      transaction: {
        id: TXN_ID,
        date: '2024-02-01',
        amount: -42500,
        payee_name: 'Amazon',
        category_name: 'Shopping',
        account_name: 'Primary Checking',
        memo: 'Updated',
        cleared: 'cleared',
        approved: true,
        flag_color: 'blue',
        ...overrides,
      },
    },
  };
}

describe('handleUpdateTransaction', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('updates a single field', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    const result = await handleUpdateTransaction(
      { transaction_id: TXN_ID, category_id: CATEGORY_ID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(mockClient.updateTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID, {
      transaction: { category_id: CATEGORY_ID },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.transaction.id).toBe(TXN_ID);
  });

  it('converts amount dollars to milliunits', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    await handleUpdateTransaction(
      { transaction_id: TXN_ID, amount: -42.5 },
      mockClient as never
    );

    expect(mockClient.updateTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID, {
      transaction: { amount: -42500 },
    });
  });

  it('passes all provided fields including null flag_color', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    await handleUpdateTransaction(
      {
        transaction_id: TXN_ID,
        date: '2024-03-01',
        memo: 'note',
        cleared: 'reconciled',
        approved: false,
        flag_color: null,
      },
      mockClient as never
    );

    expect(mockClient.updateTransaction).toHaveBeenCalledWith('test-budget-id', TXN_ID, {
      transaction: {
        date: '2024-03-01',
        memo: 'note',
        cleared: 'reconciled',
        approved: false,
        flag_color: null,
      },
    });
  });

  it('rejects when no fields are provided to update', async () => {
    await expect(
      handleUpdateTransaction({ transaction_id: TXN_ID }, mockClient as never)
    ).rejects.toThrow(/at least one field/i);
  });

  it('rejects when both payee_id and payee_name provided', async () => {
    await expect(
      handleUpdateTransaction(
        {
          transaction_id: TXN_ID,
          payee_id: '22222222-2222-2222-2222-222222222222',
          payee_name: 'Store',
        },
        mockClient as never
      )
    ).rejects.toThrow(/not both/i);
  });

  it('respects budget_id parameter', async () => {
    mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

    await handleUpdateTransaction(
      { transaction_id: TXN_ID, memo: 'x', budget_id: 'custom-budget' },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });

  describe('clearing fields with null', () => {
    it('passes category_id, payee_id and memo null through, distinct from omitted', async () => {
      mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

      await handleUpdateTransaction(
        { transaction_id: TXN_ID, category_id: null, payee_id: null, memo: null },
        mockClient as never
      );

      const sent = mockClient.updateTransaction.mock.calls[0]![2] as { transaction: Record<string, unknown> };
      expect(sent.transaction).toEqual({ category_id: null, payee_id: null, memo: null });
    });

    it('does not include fields that were omitted', async () => {
      mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());

      await handleUpdateTransaction({ transaction_id: TXN_ID, memo: null }, mockClient as never);

      const sent = mockClient.updateTransaction.mock.calls[0]![2] as { transaction: Record<string, unknown> };
      expect(sent.transaction).toEqual({ memo: null });
      expect('category_id' in sent.transaction).toBe(false);
      expect('payee_id' in sent.transaction).toBe(false);
    });

    it('counts null as a provided field', async () => {
      mockClient.updateTransaction.mockResolvedValue(updatedTxnResponse());
      await expect(
        handleUpdateTransaction({ transaction_id: TXN_ID, category_id: null }, mockClient as never)
      ).resolves.toBeTypeOf('string');
    });

    it('rejects clearing payee_id while also setting payee_name', async () => {
      await expect(
        handleUpdateTransaction({ transaction_id: TXN_ID, payee_id: null, payee_name: 'Store' }, mockClient as never)
      ).rejects.toThrow(/not both/i);
    });

    it('still validates non-null values', async () => {
      await expect(
        handleUpdateTransaction({ transaction_id: TXN_ID, category_id: 'nope' }, mockClient as never)
      ).rejects.toBeInstanceOf(ZodError);
    });

    it('declares the nullable fields in the JSON schema', () => {
      const props = (updateTransactionTool.inputSchema as { properties: Record<string, { type: unknown }> }).properties;
      for (const f of ['category_id', 'payee_id', 'memo']) expect(props[f]!.type).toEqual(['string', 'null']);
    });
  });
});
