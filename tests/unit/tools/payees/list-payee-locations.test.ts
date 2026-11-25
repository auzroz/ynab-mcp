/**
 * List Payee Locations Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListPayeeLocations as rawHandleListPayeeLocations, listPayeeLocationsOutputSchema } from '../../../../src/tools/payees/list-payee-locations.js';
import { validating } from '../output-validation.js';
import {
  createMockClient,
  createPayeeLocationsResponse,
  mockPayeeLocations,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

/** Every result is checked against the output schema (#45). */
const handleListPayeeLocations = validating(listPayeeLocationsOutputSchema, rawHandleListPayeeLocations);

describe('handleListPayeeLocations', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists locations with coordinates and count', async () => {
    mockClient.getPayeeLocations.mockResolvedValue(createPayeeLocationsResponse());

    const parsed = await handleListPayeeLocations({}, mockClient as never);

    expect(parsed.location_count).toBe(mockPayeeLocations.length);
    expect(parsed.payee_locations[0]).toHaveProperty('id');
    expect(parsed.payee_locations[0]).toHaveProperty('payee_id');
    expect(parsed.payee_locations[0].latitude).toBe(mockPayeeLocations[0]!.latitude);
    expect(parsed.payee_locations[0].longitude).toBe(mockPayeeLocations[0]!.longitude);
  });

  it('resolves custom budget_id', async () => {
    mockClient.getPayeeLocations.mockResolvedValue(createPayeeLocationsResponse([]));

    await handleListPayeeLocations({ budget_id: 'b-8' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('b-8');
    expect(mockClient.getPayeeLocations).toHaveBeenCalledWith('b-8');
  });

  it('handles empty location list', async () => {
    mockClient.getPayeeLocations.mockResolvedValue(createPayeeLocationsResponse([]));

    const parsed = await handleListPayeeLocations({}, mockClient as never);

    expect(parsed.location_count).toBe(0);
    expect(parsed.payee_locations).toEqual([]);
  });
});
