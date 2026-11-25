/**
 * List Payee Locations By Payee Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListPayeeLocationsByPayee as rawHandleListPayeeLocationsByPayee, listPayeeLocationsByPayeeOutputSchema } from '../../../../src/tools/payees/list-payee-locations-by-payee.js';
import { validating } from '../output-validation.js';
import {
  createMockClient,
  createPayeeLocationsResponse,
  getLocationsForPayee,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleListPayeeLocationsByPayee = validating(listPayeeLocationsByPayeeOutputSchema, rawHandleListPayeeLocationsByPayee);

const PAYEE_UUID = '44444444-4444-4444-4444-4444444444dd';

describe('handleListPayeeLocationsByPayee', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists locations for a specific payee', async () => {
    const krogerLocations = getLocationsForPayee('payee-kroger');
    mockClient.getPayeeLocationsByPayee.mockResolvedValue(
      createPayeeLocationsResponse(krogerLocations)
    );

    const parsed = await handleListPayeeLocationsByPayee(
      { payee_id: PAYEE_UUID },
      mockClient as never
    );

    expect(parsed.payee_id).toBe(PAYEE_UUID);
    expect(parsed.location_count).toBe(krogerLocations.length);
    expect(parsed.payee_locations[0]).toHaveProperty('id');
    expect(parsed.payee_locations[0]).toHaveProperty('latitude');
    expect(parsed.payee_locations[0]).toHaveProperty('longitude');
  });

  it('resolves budget_id and calls client with payee_id', async () => {
    mockClient.getPayeeLocationsByPayee.mockResolvedValue(createPayeeLocationsResponse([]));

    await handleListPayeeLocationsByPayee(
      { budget_id: 'b-11', payee_id: PAYEE_UUID },
      mockClient as never
    );

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-11');
    expect(mockClient.getPayeeLocationsByPayee).toHaveBeenCalledWith('b-11', PAYEE_UUID);
  });

  it('handles empty location list', async () => {
    mockClient.getPayeeLocationsByPayee.mockResolvedValue(createPayeeLocationsResponse([]));

    const parsed = await handleListPayeeLocationsByPayee(
      { payee_id: PAYEE_UUID },
      mockClient as never
    );

    expect(parsed.location_count).toBe(0);
    expect(parsed.payee_locations).toEqual([]);
  });
});
