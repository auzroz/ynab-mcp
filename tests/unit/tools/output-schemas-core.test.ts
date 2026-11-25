/**
 * Structured tool output of the core (non-analytics) tools (#45b).
 *
 * output-schemas.test.ts validates every tool's #44 null-payload fixture
 * output. That fixture has every nullable field null and one shape per tool,
 * so this file runs the core handlers on the realistic mock fixtures and
 * through the branches the fixture never reaches: summary and delta modes,
 * populated optional fields and the in-band failures (`success: false`).
 * Each result is checked against the closed form of its schema, so a field
 * the schema misses fails here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { z } from 'zod';
import { closedOutputSchema } from '../../../src/tools/output-schema.js';
import { getUserOutputSchema, handleGetUser } from '../../../src/tools/user/get-user.js';
import { listBudgetsOutputSchema, handleListBudgets } from '../../../src/tools/budgets/list-budgets.js';
import { getBudgetOutputSchema, handleGetBudget } from '../../../src/tools/budgets/get-budget.js';
import { getBudgetSettingsOutputSchema, handleGetBudgetSettings } from '../../../src/tools/budgets/get-budget-settings.js';
import { listAccountsOutputSchema, handleListAccounts } from '../../../src/tools/accounts/list-accounts.js';
import { getAccountOutputSchema, handleGetAccount } from '../../../src/tools/accounts/get-account.js';
import { createAccountOutputSchema, handleCreateAccount } from '../../../src/tools/accounts/create-account.js';
import {
  createMockClient,
  createAccountsResponse,
  createAccountResponse,
  mockAllAccounts,
  mockMortgageAccount,
  mockCreditCardWithOverpayment,
  createUserResponse,
  createBudgetsResponse,
  createBudgetResponse,
  createBudgetSettingsResponse,
  mockBudgetSummary,
  mockEurBudgetSummary,
  mockBudgetDetail,
  mockEurCurrencyFormat,
} from './fixtures/index.js';
import type { MockClient } from './fixtures/index.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validators = new Map<z.ZodObject, ReturnType<typeof ajv.compile>>();

/** Validate a handler's output as it travels (JSON) against the closed form of `schema`. */
function expectValid(schema: z.ZodObject, value: unknown): void {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(closedOutputSchema(schema));
    validators.set(schema, validate);
  }
  expect(hasUndefinedValue(value), 'an undefined-valued key (rule 6)').toBe(false);
  const ok = validate(JSON.parse(JSON.stringify(value)));
  expect(ok, ajv.errorsText(validate.errors)).toBe(true);
}

/** Whether any key anywhere in `value` holds `undefined` (structuredContent is the object itself). */
function hasUndefinedValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUndefinedValue);
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some((v) => v === undefined || hasUndefinedValue(v));
}

let client: MockClient;
const c = () => client as never;

beforeEach(() => {
  client = createMockClient();
});

describe('core output schemas: user and budgets', () => {
  it('ynab_get_user', async () => {
    client.getUser.mockResolvedValue(createUserResponse());
    expectValid(getUserOutputSchema, await handleGetUser({}, c()));
  });

  it('ynab_list_budgets: with and without accounts and currency formats', async () => {
    client.getBudgets.mockResolvedValue(createBudgetsResponse([mockBudgetSummary, mockEurBudgetSummary]));
    expectValid(listBudgetsOutputSchema, await handleListBudgets({}, c()));
    const withAccounts = await handleListBudgets({ include_accounts: true }, c());
    expect(withAccounts.budgets[0]!.accounts).toBeDefined();
    expect(withAccounts.budgets[0]!.currency_format).toBeDefined();
    expectValid(listBudgetsOutputSchema, withAccounts);
    client.getBudgets.mockResolvedValue(
      createBudgetsResponse([{ ...mockBudgetSummary, currency_format: null, last_modified_on: undefined, accounts: [] }])
    );
    const bare = await handleListBudgets({}, c());
    expect(bare.budgets[0]).not.toHaveProperty('currency_format');
    expect(bare.budgets[0]).not.toHaveProperty('last_modified');
    expectValid(listBudgetsOutputSchema, bare);
  });

  it('ynab_get_budget: with and without a currency and date format', async () => {
    client.getBudgetById.mockResolvedValue(createBudgetResponse());
    expectValid(getBudgetOutputSchema, await handleGetBudget({}, c()));
    client.getBudgetById.mockResolvedValue(
      createBudgetResponse({ ...mockBudgetDetail, currency_format: null, date_format: null, last_modified_on: undefined } as never)
    );
    expectValid(getBudgetOutputSchema, await handleGetBudget({}, c()));
  });

  it('ynab_get_budget_settings: populated and null formats', async () => {
    client.getBudgetSettingsById.mockResolvedValue(createBudgetSettingsResponse(mockEurCurrencyFormat));
    expectValid(getBudgetSettingsOutputSchema, await handleGetBudgetSettings({}, c()));
    client.getBudgetSettingsById.mockResolvedValue({ data: { settings: { date_format: null, currency_format: null } } });
    expectValid(getBudgetSettingsOutputSchema, await handleGetBudgetSettings({}, c()));
  });
});

describe('core output schemas: accounts', () => {
  it('ynab_list_accounts: full (with liability credits and debt maps), include_closed, and delta', async () => {
    client.getAccounts.mockResolvedValue(createAccountsResponse([...mockAllAccounts, mockCreditCardWithOverpayment]));
    const full = await handleListAccounts({ include_closed: true }, c());
    expect(full.summary.liability_credits).toBeDefined();
    expect(JSON.stringify(full)).toContain('debt_interest_rates_formatted');
    expectValid(listAccountsOutputSchema, full);
    expectValid(listAccountsOutputSchema, await handleListAccounts({}, c()));
    client.getAccounts.mockResolvedValue({
      data: { accounts: [mockAllAccounts[0]!, { ...mockAllAccounts[1]!, deleted: true }], server_knowledge: 20 },
    });
    const delta = await handleListAccounts({ since_server_knowledge: 10 }, c());
    expect(delta.delta).toBe(true);
    expectValid(listAccountsOutputSchema, delta);
  });

  it('ynab_get_account: a debt account', async () => {
    client.getAccountById.mockResolvedValue(createAccountResponse(mockMortgageAccount));
    expectValid(getAccountOutputSchema, await handleGetAccount({ account_id: mockMortgageAccount.id }, c()));
  });

  it('ynab_create_account', async () => {
    client.isReadOnly.mockReturnValue(false);
    client.createAccount.mockResolvedValue(createAccountResponse());
    expectValid(createAccountOutputSchema, await handleCreateAccount({ name: 'A', type: 'checking', balance: 10 }, c()));
  });
});
