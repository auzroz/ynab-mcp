/**
 * Get Payee Location Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetPayeeLocation } from '../../../../src/tools/payees/get-payee-location.js';
import {
  createMockClient,
  createPayeeLocationResponse,
  mockPayeeLocations,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const LOCATION_UUID = '33333333-3333-3333-3333-3333333333cc';

describe('handleGetPayeeLocation', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns a single payee location', async () => {
    mockClient.getPayeeLocationById.mockResolvedValue(createPayeeLocationResponse());

    const result = await handleGetPayeeLocation(
      { payee_location_id: LOCATION_UUID },
      mockClient as never
    );
    const parsed = JSON.parse(result);

    expect(parsed.payee_location.id).toBe(mockPayeeLocations[0]!.id);
    expect(parsed.payee_location.payee_id).toBe(mockPayeeLocations[0]!.payee_id);
    expect(parsed.payee_location.latitude).toBe(mockPayeeLocations[0]!.latitude);
    expect(parsed.payee_location.longitude).toBe(mockPayeeLocations[0]!.longitude);
  });

  it('resolves budget_id and calls client with location id', async () => {
    mockClient.getPayeeLocationById.mockResolvedValue(createPayeeLocationResponse());

    await handleGetPayeeLocation(
      { budget_id: 'b-10', payee_location_id: LOCATION_UUID },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-10');
    expect(mockClient.getPayeeLocationById).toHaveBeenCalledWith('b-10', LOCATION_UUID);
  });
});
