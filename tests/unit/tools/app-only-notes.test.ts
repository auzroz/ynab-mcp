import { describe, it, expect } from 'vitest';
import { listCategoriesTool } from '../../../src/tools/categories/list-categories.js';
import { getCategoryTool } from '../../../src/tools/categories/get-category.js';
import { updateCategoryDetailsTool } from '../../../src/tools/categories/update-category-details.js';
import { createCategoryGroupTool } from '../../../src/tools/categories/create-category-group.js';
import { updateCategoryGroupTool } from '../../../src/tools/categories/update-category-group.js';
import { listAccountsTool } from '../../../src/tools/accounts/list-accounts.js';
import { createAccountTool } from '../../../src/tools/accounts/create-account.js';
import { listPayeesTool } from '../../../src/tools/payees/list-payees.js';
import { updatePayeeTool } from '../../../src/tools/payees/update-payee.js';
import { listBudgetsTool } from '../../../src/tools/budgets/list-budgets.js';
import { getBudgetSettingsTool } from '../../../src/tools/budgets/get-budget-settings.js';

const MARKER = 'Not possible through the YNAB API (do it in the YNAB app):';

describe('app-only limitation notes', () => {
  const cases: [string, { description?: string }, RegExp][] = [
    ['get_category', getCategoryTool, /due days/],
    ['update_category_details', updateCategoryDetailsTool, /snoozing/],
    ['list_categories', listCategoriesTool, /reordering categories and groups/],
    ['create_category_group', createCategoryGroupTool, /category groups/],
    ['update_category_group', updateCategoryGroupTool, /category groups/],
    ['list_accounts', listAccountsTool, /loan accounts/],
    ['create_account', createAccountTool, /interest rates/],
    ['list_payees', listPayeesTool, /merging payees/],
    ['update_payee', updatePayeeTool, /payee locations/],
    ['list_budgets', listBudgetsTool, /plans/],
    ['get_budget_settings', getBudgetSettingsTool, /plan settings/],
  ];

  it.each(cases)('%s mentions what must be done in the app', (_name, tool, pattern) => {
    expect(tool.description).toContain(MARKER);
    expect(tool.description).toMatch(pattern);
  });
});
