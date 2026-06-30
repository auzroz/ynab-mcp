/**
 * Get Payee Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetPayee } from '../../../../src/tools/payees/get-payee.js';
import {
  createMockClient,
  createPayeeResponse,
  mockPayees,
  mockTransferPayees,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const PAYEE_UUID = '11111111-1111-1111-1111-1111111111aa';

describe('handleGetPayee', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns payee details with null transfer_account_id', async () => {
    mockClient.getPayeeById.mockResolvedValue(createPayeeResponse(mockPayees[0]));

    const result = await handleGetPayee({ payee_id: PAYEE_UUID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.payee.id).toBe(mockPayees[0]!.id);
    expect(parsed.payee.name).toBe('Kroger');
    expect(parsed.payee.transfer_account_id).toBeNull();
    expect(parsed.payee.deleted).toBe(false);
  });

  it('returns transfer_account_id for transfer payees', async () => {
    mockClient.getPayeeById.mockResolvedValue(createPayeeResponse(mockTransferPayees[0]));

    const result = await handleGetPayee({ payee_id: PAYEE_UUID }, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.payee.transfer_account_id).toBe(mockTransferPayees[0]!.transfer_account_id);
  });

  it('resolves budget_id and calls client with payee_id', async () => {
    mockClient.getPayeeById.mockResolvedValue(createPayeeResponse(mockPayees[0]));

    await handleGetPayee({ budget_id: 'b-5', payee_id: PAYEE_UUID }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-5');
    expect(mockClient.getPayeeById).toHaveBeenCalledWith('b-5', PAYEE_UUID);
  });
});
