/**
 * Mock Category Fixtures
 *
 * Realistic YNAB category data for testing.
 */

import type { Category, CategoryGroupWithCategories } from 'ynab';

// Type for mock categories with flexible goal_type
type MockCategory = Omit<Category, 'goal_type'> & { goal_type: string | null };

// Helper to create a category
function createCategory(overrides: Partial<MockCategory> & { id: string; name: string }): MockCategory {
  return {
    category_group_id: 'group-1',
    budgeted: 0,
    activity: 0,
    balance: 0,
    goal_type: null,
    goal_day: null,
    goal_cadence: null,
    goal_cadence_frequency: null,
    goal_creation_month: null,
    goal_target: null,
    goal_target_month: null,
    goal_percentage_complete: null,
    goal_months_to_budget: null,
    goal_under_funded: null,
    goal_overall_funded: null,
    goal_overall_left: null,
    note: null,
    original_category_group_id: null,
    hidden: false,
    deleted: false,
    ...overrides,
  };
}

// Bills category group
export const mockBillsCategories: MockCategory[] = [
  createCategory({
    id: 'cat-rent-111',
    name: 'Rent/Mortgage',
    category_group_id: 'group-bills',
    budgeted: 1500000, // $1,500
    activity: -1500000,
    balance: 0,
    goal_type: 'MF',
    goal_target: 1500000,
    goal_percentage_complete: 100,
  }),
  createCategory({
    id: 'cat-utilities-222',
    name: 'Utilities',
    category_group_id: 'group-bills',
    budgeted: 200000, // $200
    activity: -175000, // $175 spent
    balance: 25000, // $25 remaining
    goal_type: 'NEED',
    goal_target: 200000,
    goal_percentage_complete: 100,
  }),
  createCategory({
    id: 'cat-internet-333',
    name: 'Internet',
    category_group_id: 'group-bills',
    budgeted: 80000, // $80
    activity: -80000,
    balance: 0,
    goal_type: 'MF',
    goal_target: 80000,
    goal_percentage_complete: 100,
  }),
  createCategory({
    id: 'cat-phone-444',
    name: 'Phone',
    category_group_id: 'group-bills',
    budgeted: 75000, // $75
    activity: -75000,
    balance: 0,
    goal_type: 'MF',
    goal_target: 75000,
    goal_percentage_complete: 100,
  }),
];

// Everyday expenses category group
export const mockEverydayCategories: MockCategory[] = [
  createCategory({
    id: 'cat-groceries-555',
    name: 'Groceries',
    category_group_id: 'group-everyday',
    budgeted: 600000, // $600
    activity: -450000, // $450 spent
    balance: 150000, // $150 remaining
    goal_type: 'NEED',
    goal_target: 600000,
    goal_percentage_complete: 100,
  }),
  createCategory({
    id: 'cat-dining-666',
    name: 'Dining Out',
    category_group_id: 'group-everyday',
    budgeted: 200000, // $200
    activity: -275000, // $275 spent - OVERSPENT
    balance: -75000, // -$75 overspent
    goal_type: 'NEED',
    goal_target: 200000,
    goal_percentage_complete: 100,
  }),
  createCategory({
    id: 'cat-transport-777',
    name: 'Transportation',
    category_group_id: 'group-everyday',
    budgeted: 300000, // $300
    activity: -180000, // $180 spent
    balance: 120000, // $120 remaining
    goal_type: 'NEED',
    goal_target: 300000,
    goal_percentage_complete: 100,
  }),
  createCategory({
    id: 'cat-gas-888',
    name: 'Gas',
    category_group_id: 'group-everyday',
    budgeted: 150000, // $150
    activity: -125000, // $125 spent
    balance: 25000, // $25 remaining
    goal_type: 'NEED',
    goal_target: 150000,
    goal_percentage_complete: 100,
  }),
];

// Savings goals category group
export const mockSavingsCategories: MockCategory[] = [
  createCategory({
    id: 'cat-emergency-999',
    name: 'Emergency Fund',
    category_group_id: 'group-savings',
    budgeted: 500000, // $500
    activity: 0,
    balance: 10000000, // $10,000 saved
    goal_type: 'TB',
    goal_target: 15000000, // $15,000 target
    goal_percentage_complete: 67,
    goal_overall_funded: 10000000,
    goal_overall_left: 5000000,
  }),
  createCategory({
    id: 'cat-vacation-aaa',
    name: 'Vacation',
    category_group_id: 'group-savings',
    budgeted: 200000, // $200
    activity: 0,
    balance: 1200000, // $1,200 saved
    goal_type: 'TBD',
    goal_target: 3000000, // $3,000 target
    goal_target_month: '2024-06-01',
    goal_percentage_complete: 40,
    goal_under_funded: 300000, // $300 underfunded
    goal_overall_funded: 1200000,
    goal_overall_left: 1800000,
    goal_months_to_budget: 4,
  }),
  createCategory({
    id: 'cat-car-bbb',
    name: 'New Car Fund',
    category_group_id: 'group-savings',
    budgeted: 300000, // $300
    activity: 0,
    balance: 5000000, // $5,000 saved
    goal_type: 'TBD',
    goal_target: 20000000, // $20,000 target
    goal_target_month: '2025-12-01',
    goal_percentage_complete: 25,
    goal_under_funded: 0,
    goal_overall_funded: 5000000,
    goal_overall_left: 15000000,
    goal_months_to_budget: 20,
  }),
];

// Discretionary spending category group
export const mockDiscretionaryCategories: MockCategory[] = [
  createCategory({
    id: 'cat-entertainment-ccc',
    name: 'Entertainment',
    category_group_id: 'group-discretionary',
    budgeted: 100000, // $100
    activity: -85000, // $85 spent
    balance: 15000, // $15 remaining
  }),
  createCategory({
    id: 'cat-subscriptions-ddd',
    name: 'Subscriptions',
    category_group_id: 'group-discretionary',
    budgeted: 50000, // $50
    activity: -65000, // $65 spent - OVERSPENT
    balance: -15000, // -$15 overspent
  }),
  createCategory({
    id: 'cat-shopping-eee',
    name: 'Shopping',
    category_group_id: 'group-discretionary',
    budgeted: 150000, // $150
    activity: -100000, // $100 spent
    balance: 50000, // $50 remaining
  }),
  createCategory({
    id: 'cat-hobbies-fff',
    name: 'Hobbies',
    category_group_id: 'group-discretionary',
    budgeted: 75000, // $75
    activity: 0, // Nothing spent
    balance: 75000, // Full amount remaining
  }),
];

// Hidden/unused category
export const mockHiddenCategory: MockCategory = createCategory({
  id: 'cat-hidden-ggg',
  name: 'Old Category',
  category_group_id: 'group-hidden',
  budgeted: 0,
  activity: 0,
  balance: 0,
  hidden: true,
});

// Credit card payment category
export const mockCreditCardPaymentCategory: MockCategory = createCategory({
  id: 'cat-cc-payment-hhh',
  name: 'Chase Visa',
  category_group_id: 'group-credit-cards',
  budgeted: 1500000, // $1,500
  activity: -1500000,
  balance: 0,
  note: 'Credit card payment category',
});

// Internal category (Ready to Assign)
export const mockReadyToAssignCategory: MockCategory = createCategory({
  id: 'cat-rta-iii',
  name: 'Inflow: Ready to Assign',
  category_group_id: 'group-internal',
  budgeted: 0,
  activity: 5000000, // $5,000 income
  balance: 500000, // $500 to be budgeted
});

// Category groups
export const mockCategoryGroups: CategoryGroupWithCategories[] = [
  {
    id: 'group-internal',
    name: 'Internal Master Category',
    hidden: true,
    deleted: false,
    categories: [mockReadyToAssignCategory as unknown as Category],
  },
  {
    id: 'group-credit-cards',
    name: 'Credit Card Payments',
    hidden: false,
    deleted: false,
    categories: [mockCreditCardPaymentCategory as unknown as Category],
  },
  {
    id: 'group-bills',
    name: 'Bills',
    hidden: false,
    deleted: false,
    categories: mockBillsCategories as unknown as Category[],
  },
  {
    id: 'group-everyday',
    name: 'Everyday Expenses',
    hidden: false,
    deleted: false,
    categories: mockEverydayCategories as unknown as Category[],
  },
  {
    id: 'group-savings',
    name: 'Savings Goals',
    hidden: false,
    deleted: false,
    categories: mockSavingsCategories as unknown as Category[],
  },
  {
    id: 'group-discretionary',
    name: 'Discretionary',
    hidden: false,
    deleted: false,
    categories: mockDiscretionaryCategories as unknown as Category[],
  },
  {
    id: 'group-hidden',
    name: 'Hidden',
    hidden: true,
    deleted: false,
    categories: [mockHiddenCategory as unknown as Category],
  },
];

// All categories flat list
export const mockAllCategories: MockCategory[] = [
  mockReadyToAssignCategory,
  mockCreditCardPaymentCategory,
  ...mockBillsCategories,
  ...mockEverydayCategories,
  ...mockSavingsCategories,
  ...mockDiscretionaryCategories,
  mockHiddenCategory,
];

// Response factories
export function createCategoriesResponse(groups = mockCategoryGroups) {
  return {
    data: {
      category_groups: groups,
      server_knowledge: 12345,
    },
  };
}

export function createCategoryResponse(category: MockCategory = mockBillsCategories[0]!) {
  return {
    data: {
      category: category as unknown as Category,
    },
  };
}

// Preset scenarios
export const healthyBudgetCategories = mockCategoryGroups;

export const overspentBudgetCategories: CategoryGroupWithCategories[] = [
  ...mockCategoryGroups.slice(0, 3),
  {
    id: 'group-everyday',
    name: 'Everyday Expenses',
    hidden: false,
    deleted: false,
    categories: mockEverydayCategories.map((c) => ({
      ...c,
      balance: c.balance - 200000, // Make all overspent
    })) as unknown as Category[],
  },
  ...mockCategoryGroups.slice(4),
];
