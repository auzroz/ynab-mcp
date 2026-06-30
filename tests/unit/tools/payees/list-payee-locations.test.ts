/**
 * List Payee Locations Tool Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListPayeeLocations } from '../../../../src/tools/payees/list-payee-locations.js';
import {
  createMockClient,
  createPayeeLocationsResponse,
  mockPayeeLocations,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('handleListPayeeLocations', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('lists locations with coordinates and count', async () => {
    mockClient.getPayeeLocations.mockResolvedValue(createPayeeLocationsResponse());

    const result = await handleListPayeeLocations({}, mockClient as never);
    const parsed = JSON.parse(result);

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

    const result = await handleListPayeeLocations({}, mockClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.location_count).toBe(0);
    expect(parsed.payee_locations).toEqual([]);
  });
});
