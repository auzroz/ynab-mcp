/**
 * Get Payee Location Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetPayeeLocation as rawHandleGetPayeeLocation, getPayeeLocationOutputSchema } from '../../../../src/tools/payees/get-payee-location.js';
import { validating } from '../output-validation.js';
import {
  createMockClient,
  createPayeeLocationResponse,
  mockPayeeLocations,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleGetPayeeLocation = validating(getPayeeLocationOutputSchema, rawHandleGetPayeeLocation);

const LOCATION_UUID = '33333333-3333-3333-3333-3333333333cc';

describe('handleGetPayeeLocation', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns a single payee location', async () => {
    mockClient.getPayeeLocationById.mockResolvedValue(createPayeeLocationResponse());

    const parsed = await handleGetPayeeLocation(
      { payee_location_id: LOCATION_UUID },
      mockClient as never
    );

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
