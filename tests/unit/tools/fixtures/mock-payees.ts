/**
 * Mock Payee Fixtures
 *
 * Realistic YNAB payee data for testing.
 */

import type { Payee, PayeeLocation } from 'ynab';

// Common payees
export const mockPayees: Payee[] = [
  {
    id: 'payee-kroger',
    name: 'Kroger',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-whole-foods',
    name: 'Whole Foods',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-chipotle',
    name: 'Chipotle',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-olive-garden',
    name: 'Olive Garden',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-starbucks',
    name: 'Starbucks',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-sushi-place',
    name: 'Tokyo Sushi',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-netflix',
    name: 'Netflix',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-spotify',
    name: 'Spotify',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-planet-fitness',
    name: 'Planet Fitness',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-landlord',
    name: 'ABC Property Management',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-electric',
    name: 'City Electric',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-comcast',
    name: 'Comcast',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-verizon',
    name: 'Verizon',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-employer',
    name: 'Acme Corp',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-amazon',
    name: 'Amazon',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-target',
    name: 'Target',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-gas-station',
    name: 'Shell Gas',
    transfer_account_id: null,
    deleted: false,
  },
  {
    id: 'payee-unknown',
    name: 'Unknown Merchant',
    transfer_account_id: null,
    deleted: false,
  },
];

// Transfer payees (auto-created for transfers)
export const mockTransferPayees: Payee[] = [
  {
    id: 'tp-checking-111',
    name: 'Transfer : Primary Checking',
    transfer_account_id: '11111111-1111-1111-1111-111111111111',
    deleted: false,
  },
  {
    id: 'tp-savings-222',
    name: 'Transfer : Emergency Fund',
    transfer_account_id: '22222222-2222-2222-2222-222222222222',
    deleted: false,
  },
  {
    id: 'tp-cc-333',
    name: 'Transfer : Chase Visa',
    transfer_account_id: '33333333-3333-3333-3333-333333333333',
    deleted: false,
  },
];

// Deleted payee
export const mockDeletedPayee: Payee = {
  id: 'payee-deleted',
  name: 'Old Store',
  transfer_account_id: null,
  deleted: true,
};

// All payees
export const mockAllPayees: Payee[] = [...mockPayees, ...mockTransferPayees, mockDeletedPayee];

// Payee locations
export const mockPayeeLocations: PayeeLocation[] = [
  {
    id: 'loc-kroger-1',
    payee_id: 'payee-kroger',
    latitude: '39.7392',
    longitude: '-104.9903',
    deleted: false,
  },
  {
    id: 'loc-kroger-2',
    payee_id: 'payee-kroger',
    latitude: '39.7500',
    longitude: '-105.0000',
    deleted: false,
  },
  {
    id: 'loc-starbucks-1',
    payee_id: 'payee-starbucks',
    latitude: '39.7400',
    longitude: '-104.9850',
    deleted: false,
  },
  {
    id: 'loc-chipotle-1',
    payee_id: 'payee-chipotle',
    latitude: '39.7450',
    longitude: '-104.9900',
    deleted: false,
  },
  {
    id: 'loc-target-1',
    payee_id: 'payee-target',
    latitude: '39.7300',
    longitude: '-104.9800',
    deleted: false,
  },
];

// Response factories
export function createPayeesResponse(payees: Payee[] = mockAllPayees) {
  return {
    data: {
      payees,
      server_knowledge: 12345,
    },
  };
}

export function createPayeeResponse(payee: Payee = mockPayees[0]!) {
  return {
    data: {
      payee,
    },
  };
}

export function createPayeeLocationsResponse(locations: PayeeLocation[] = mockPayeeLocations) {
  return {
    data: {
      payee_locations: locations,
    },
  };
}

export function createPayeeLocationResponse(location: PayeeLocation = mockPayeeLocations[0]!) {
  return {
    data: {
      payee_location: location,
    },
  };
}

// Helper to get payee by ID
export function getPayeeById(payeeId: string): Payee | undefined {
  return mockAllPayees.find((p) => p.id === payeeId);
}

// Helper to get locations for a payee
export function getLocationsForPayee(payeeId: string): PayeeLocation[] {
  return mockPayeeLocations.filter((l) => l.payee_id === payeeId);
}

// Subscription payees (for recurring detection)
export const mockSubscriptionPayees = mockPayees.filter((p) =>
  ['payee-netflix', 'payee-spotify', 'payee-planet-fitness', 'payee-comcast', 'payee-verizon'].includes(p.id)
);

// Dining payees
export const mockDiningPayees = mockPayees.filter((p) =>
  ['payee-chipotle', 'payee-olive-garden', 'payee-starbucks', 'payee-sushi-place'].includes(p.id)
);

// Grocery payees
export const mockGroceryPayees = mockPayees.filter((p) =>
  ['payee-kroger', 'payee-whole-foods'].includes(p.id)
);
