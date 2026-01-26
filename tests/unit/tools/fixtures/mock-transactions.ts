/**
 * Mock Transaction Fixtures
 *
 * Realistic YNAB transaction data for testing.
 */

import type { TransactionDetail, ScheduledTransactionDetail } from 'ynab';

// Type for mock transactions with flexible cleared status
type MockTransaction = Omit<TransactionDetail, 'cleared' | 'flag_color'> & {
  cleared: string;
  flag_color: string | null;
};

// Helper to create a transaction
function createTransaction(
  overrides: Partial<MockTransaction> & { id: string; date: string; amount: number }
): MockTransaction {
  return {
    account_id: '11111111-1111-1111-1111-111111111111',
    account_name: 'Primary Checking',
    payee_id: null,
    payee_name: null,
    category_id: null,
    category_name: null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    import_id: null,
    import_payee_name: null,
    import_payee_name_original: null,
    debt_transaction_type: null,
    memo: null,
    cleared: 'cleared',
    approved: true,
    flag_color: null,
    flag_name: null,
    subtransactions: [],
    deleted: false,
    ...overrides,
  };
}

// Grocery transactions (recurring pattern)
export const mockGroceryTransactions: MockTransaction[] = [
  createTransaction({
    id: 'txn-grocery-001',
    date: '2024-01-05',
    amount: -85000, // $85
    payee_id: 'payee-kroger',
    payee_name: 'Kroger',
    category_id: 'cat-groceries-555',
    category_name: 'Groceries',
    memo: 'Weekly groceries',
  }),
  createTransaction({
    id: 'txn-grocery-002',
    date: '2024-01-12',
    amount: -92000, // $92
    payee_id: 'payee-kroger',
    payee_name: 'Kroger',
    category_id: 'cat-groceries-555',
    category_name: 'Groceries',
  }),
  createTransaction({
    id: 'txn-grocery-003',
    date: '2024-01-19',
    amount: -78000, // $78
    payee_id: 'payee-kroger',
    payee_name: 'Kroger',
    category_id: 'cat-groceries-555',
    category_name: 'Groceries',
  }),
  createTransaction({
    id: 'txn-grocery-004',
    date: '2024-01-26',
    amount: -105000, // $105
    payee_id: 'payee-whole-foods',
    payee_name: 'Whole Foods',
    category_id: 'cat-groceries-555',
    category_name: 'Groceries',
    memo: 'Special dinner ingredients',
  }),
];

// Dining transactions
export const mockDiningTransactions: MockTransaction[] = [
  createTransaction({
    id: 'txn-dining-001',
    date: '2024-01-03',
    amount: -45000, // $45
    payee_id: 'payee-chipotle',
    payee_name: 'Chipotle',
    category_id: 'cat-dining-666',
    category_name: 'Dining Out',
  }),
  createTransaction({
    id: 'txn-dining-002',
    date: '2024-01-08',
    amount: -85000, // $85
    payee_id: 'payee-olive-garden',
    payee_name: 'Olive Garden',
    category_id: 'cat-dining-666',
    category_name: 'Dining Out',
    memo: 'Dinner with friends',
  }),
  createTransaction({
    id: 'txn-dining-003',
    date: '2024-01-15',
    amount: -32000, // $32
    payee_id: 'payee-starbucks',
    payee_name: 'Starbucks',
    category_id: 'cat-dining-666',
    category_name: 'Dining Out',
  }),
  createTransaction({
    id: 'txn-dining-004',
    date: '2024-01-22',
    amount: -68000, // $68
    payee_id: 'payee-sushi-place',
    payee_name: 'Tokyo Sushi',
    category_id: 'cat-dining-666',
    category_name: 'Dining Out',
  }),
  createTransaction({
    id: 'txn-dining-005',
    date: '2024-01-28',
    amount: -45000, // $45
    payee_id: 'payee-chipotle',
    payee_name: 'Chipotle',
    category_id: 'cat-dining-666',
    category_name: 'Dining Out',
  }),
];

// Subscription transactions (monthly recurring)
export const mockSubscriptionTransactions: MockTransaction[] = [
  createTransaction({
    id: 'txn-netflix-001',
    date: '2024-01-01',
    amount: -15990, // $15.99
    payee_id: 'payee-netflix',
    payee_name: 'Netflix',
    category_id: 'cat-subscriptions-ddd',
    category_name: 'Subscriptions',
    import_id: 'YNAB:15990:2024-01-01:1',
  }),
  createTransaction({
    id: 'txn-spotify-001',
    date: '2024-01-05',
    amount: -10990, // $10.99
    payee_id: 'payee-spotify',
    payee_name: 'Spotify',
    category_id: 'cat-subscriptions-ddd',
    category_name: 'Subscriptions',
    import_id: 'YNAB:10990:2024-01-05:1',
  }),
  createTransaction({
    id: 'txn-gym-001',
    date: '2024-01-01',
    amount: -39000, // $39
    payee_id: 'payee-planet-fitness',
    payee_name: 'Planet Fitness',
    category_id: 'cat-subscriptions-ddd',
    category_name: 'Subscriptions',
    import_id: 'YNAB:39000:2024-01-01:1',
  }),
];

// Bill transactions
export const mockBillTransactions: MockTransaction[] = [
  createTransaction({
    id: 'txn-rent-001',
    date: '2024-01-01',
    amount: -1500000, // $1,500
    payee_id: 'payee-landlord',
    payee_name: 'ABC Property Management',
    category_id: 'cat-rent-111',
    category_name: 'Rent/Mortgage',
    memo: 'January rent',
    cleared: 'reconciled',
  }),
  createTransaction({
    id: 'txn-electric-001',
    date: '2024-01-10',
    amount: -125000, // $125
    payee_id: 'payee-electric',
    payee_name: 'City Electric',
    category_id: 'cat-utilities-222',
    category_name: 'Utilities',
    import_id: 'YNAB:125000:2024-01-10:1',
  }),
  createTransaction({
    id: 'txn-internet-001',
    date: '2024-01-15',
    amount: -80000, // $80
    payee_id: 'payee-comcast',
    payee_name: 'Comcast',
    category_id: 'cat-internet-333',
    category_name: 'Internet',
    import_id: 'YNAB:80000:2024-01-15:1',
  }),
  createTransaction({
    id: 'txn-phone-001',
    date: '2024-01-18',
    amount: -75000, // $75
    payee_id: 'payee-verizon',
    payee_name: 'Verizon',
    category_id: 'cat-phone-444',
    category_name: 'Phone',
    import_id: 'YNAB:75000:2024-01-18:1',
  }),
];

// Income transactions
export const mockIncomeTransactions: MockTransaction[] = [
  createTransaction({
    id: 'txn-paycheck-001',
    date: '2024-01-15',
    amount: 2500000, // $2,500
    payee_id: 'payee-employer',
    payee_name: 'Acme Corp',
    category_id: 'cat-rta-iii',
    category_name: 'Inflow: Ready to Assign',
    memo: 'Paycheck',
    cleared: 'reconciled',
  }),
  createTransaction({
    id: 'txn-paycheck-002',
    date: '2024-01-31',
    amount: 2500000, // $2,500
    payee_id: 'payee-employer',
    payee_name: 'Acme Corp',
    category_id: 'cat-rta-iii',
    category_name: 'Inflow: Ready to Assign',
    memo: 'Paycheck',
    cleared: 'cleared',
  }),
];

// Transfer transaction
export const mockTransferTransaction: MockTransaction = createTransaction({
  id: 'txn-transfer-001',
  date: '2024-01-20',
  amount: -500000, // $500
  payee_id: null,
  payee_name: 'Transfer : Emergency Fund',
  category_id: null,
  category_name: null,
  transfer_account_id: '22222222-2222-2222-2222-222222222222',
  transfer_transaction_id: 'txn-transfer-001-paired',
  memo: 'Monthly savings transfer',
});

// Credit card payment transaction
export const mockCreditCardPaymentTransaction: MockTransaction = createTransaction({
  id: 'txn-cc-payment-001',
  date: '2024-01-25',
  amount: -1500000, // $1,500
  account_id: '11111111-1111-1111-1111-111111111111',
  account_name: 'Primary Checking',
  payee_id: null,
  payee_name: 'Transfer : Chase Visa',
  category_id: null,
  category_name: null,
  transfer_account_id: '33333333-3333-3333-3333-333333333333',
  transfer_transaction_id: 'txn-cc-payment-001-paired',
  memo: 'Credit card payment',
});

// Split transaction
export const mockSplitTransaction: MockTransaction = createTransaction({
  id: 'txn-split-001',
  date: '2024-01-20',
  amount: -150000, // $150
  payee_id: 'payee-amazon',
  payee_name: 'Amazon',
  category_id: null,
  category_name: 'Split (2 categories)',
  memo: 'Various items',
  subtransactions: [
    {
      id: 'sub-001',
      transaction_id: 'txn-split-001',
      amount: -100000, // $100
      memo: 'Books',
      payee_id: null,
      payee_name: null,
      category_id: 'cat-entertainment-ccc',
      category_name: 'Entertainment',
      transfer_account_id: null,
      transfer_transaction_id: null,
      deleted: false,
    },
    {
      id: 'sub-002',
      transaction_id: 'txn-split-001',
      amount: -50000, // $50
      memo: 'Kitchen supplies',
      payee_id: null,
      payee_name: null,
      category_id: 'cat-shopping-eee',
      category_name: 'Shopping',
      transfer_account_id: null,
      transfer_transaction_id: null,
      deleted: false,
    },
  ],
});

// Uncleared transaction
export const mockUnclearedTransaction: MockTransaction = createTransaction({
  id: 'txn-uncleared-001',
  date: '2024-01-30',
  amount: -55000, // $55
  payee_id: 'payee-target',
  payee_name: 'Target',
  category_id: 'cat-shopping-eee',
  category_name: 'Shopping',
  cleared: 'uncleared',
  approved: false,
});

// Flagged transaction
export const mockFlaggedTransaction: MockTransaction = createTransaction({
  id: 'txn-flagged-001',
  date: '2024-01-22',
  amount: -200000, // $200
  payee_id: 'payee-unknown',
  payee_name: 'Unknown Merchant',
  category_id: 'cat-shopping-eee',
  category_name: 'Shopping',
  flag_color: 'red',
  memo: 'Need to verify this charge',
});

// All transactions combined
export const mockAllTransactions: MockTransaction[] = [
  ...mockGroceryTransactions,
  ...mockDiningTransactions,
  ...mockSubscriptionTransactions,
  ...mockBillTransactions,
  ...mockIncomeTransactions,
  mockTransferTransaction,
  mockCreditCardPaymentTransaction,
  mockSplitTransaction,
  mockUnclearedTransaction,
  mockFlaggedTransaction,
];

// Scheduled transactions
export const mockScheduledTransactions: ScheduledTransactionDetail[] = [
  {
    id: 'sched-rent-001',
    date_first: '2024-01-01',
    date_next: '2024-02-01',
    frequency: 'monthly',
    amount: -1500000, // $1,500
    memo: 'Monthly rent',
    flag_color: null,
    flag_name: null,
    account_id: '11111111-1111-1111-1111-111111111111',
    account_name: 'Primary Checking',
    payee_id: 'payee-landlord',
    payee_name: 'ABC Property Management',
    category_id: 'cat-rent-111',
    category_name: 'Rent/Mortgage',
    transfer_account_id: null,
    deleted: false,
    subtransactions: [],
  },
  {
    id: 'sched-paycheck-001',
    date_first: '2024-01-15',
    date_next: '2024-02-15',
    frequency: 'twiceAMonth',
    amount: 2500000, // $2,500
    memo: 'Paycheck',
    flag_color: null,
    flag_name: null,
    account_id: '11111111-1111-1111-1111-111111111111',
    account_name: 'Primary Checking',
    payee_id: 'payee-employer',
    payee_name: 'Acme Corp',
    category_id: 'cat-rta-iii',
    category_name: 'Inflow: Ready to Assign',
    transfer_account_id: null,
    deleted: false,
    subtransactions: [],
  },
  {
    id: 'sched-savings-001',
    date_first: '2024-01-20',
    date_next: '2024-02-20',
    frequency: 'monthly',
    amount: -500000, // $500
    memo: 'Monthly savings',
    flag_color: null,
    flag_name: null,
    account_id: '11111111-1111-1111-1111-111111111111',
    account_name: 'Primary Checking',
    payee_id: null,
    payee_name: 'Transfer : Emergency Fund',
    category_id: null,
    category_name: null,
    transfer_account_id: '22222222-2222-2222-2222-222222222222',
    deleted: false,
    subtransactions: [],
  },
];

// Response factories
export function createTransactionsResponse(transactions: MockTransaction[] = mockAllTransactions) {
  return {
    data: {
      transactions: transactions as unknown as TransactionDetail[],
      server_knowledge: 12345,
    },
  };
}

export function createTransactionResponse(transaction: MockTransaction = mockGroceryTransactions[0]!) {
  return {
    data: {
      transaction: transaction as unknown as TransactionDetail,
    },
  };
}

export function createScheduledTransactionsResponse(
  transactions: ScheduledTransactionDetail[] = mockScheduledTransactions
) {
  return {
    data: {
      scheduled_transactions: transactions,
      server_knowledge: 12345,
    },
  };
}

export function createScheduledTransactionResponse(
  transaction: ScheduledTransactionDetail = mockScheduledTransactions[0]!
) {
  return {
    data: {
      scheduled_transaction: transaction,
    },
  };
}

// Preset scenarios
export function createMonthTransactions(yearMonth: string): MockTransaction[] {
  return mockAllTransactions
    .filter((t) => !t.transfer_account_id) // Exclude transfers for spending analysis
    .map((t) => ({
      ...t,
      id: `${t.id}-${yearMonth}`,
      date: t.date.replace(/^\d{4}-\d{2}/, yearMonth),
    }));
}
