/**
 * Create Account Tool
 *
 * Creates a new account in a budget.
 *
 * Note: amounts are formatted with the budget's currency_format (moneyFormatterFor),
 * falling back to the USD style when the settings cannot be read. Raw values stay
 * in milliunits regardless of currency.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { NAME_MAX_LENGTH, budgetId } from '../../utils/schemas.js';
import { toOutputSchema } from '../output-schema.js';
import { money } from '../schemas/common.js';

// Derive account types from the YNAB SDK enum to prevent drift. The YNAB API
// only supports CREATING this restricted set (SaveAccountType) — loan/mortgage
// types are tracked differently and cannot be created via the API.
const accountTypeValues = Object.values(ynab.SaveAccountType).filter(
  (v): v is ynab.SaveAccountType => typeof v === 'string'
);

// Input schema using z.enum (zod 4 enum-object form) for proper enum validation
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  name: z.string().min(1).max(NAME_MAX_LENGTH).describe('The name of the account'),
  type: z
    .enum(ynab.SaveAccountType)
    .describe('The type of account (checking, savings, cash, creditCard, otherAsset, otherLiability)'),
  balance: z
    .number()
    .finite()
    .describe('The starting balance in dollars (e.g., 1000.50 for $1,000.50)'),
});

// Tool definition
/** What the tool returns (#45; rules in ../output-schema.ts). */
export const createAccountOutputSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  account: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string().describe('YNAB account type'),
    balance: money(),
    on_budget: z.boolean(),
  }),
});
export type CreateAccountOutput = z.output<typeof createAccountOutputSchema>;

export const createAccountTool: Tool = {
  name: 'ynab_create_account',
  description: `Create a new account in a budget.

Use when the user asks:
- "Add a new checking account"
- "Create a savings account"
- "I want to add my credit card to YNAB"
- "Set up a new account with balance X"

Account types (only these can be created via the YNAB API): checking, savings, cash, creditCard, otherAsset, otherLiability

Balance should be provided in dollars (e.g., 1000.50). For credit cards and liability accounts, use a negative balance for amounts owed.

Not possible through the YNAB API (do it in the YNAB app): editing, closing or reopening accounts, setting up loan accounts, and changing interest rates.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      name: {
        type: 'string',
        maxLength: 200,
        description: 'The name of the account',
      },
      type: {
        type: 'string',
        enum: accountTypeValues,
        description: 'The type of account',
      },
      balance: {
        type: 'number',
        description: 'The starting balance in dollars (e.g., 1000.50)',
      },
    },
    required: ['name', 'type', 'balance'],
  },
  outputSchema: toOutputSchema(createAccountOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_create_account tool.
 */
export async function handleCreateAccount(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<CreateAccountOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id, { fresh: true });

  const response = await client.createAccount(budgetId, {
    account: {
      name: validated.name,
      type: validated.type,
      balance: toMilliunits(validated.balance),
    },
  });

  const money = await moneyFormatterFor(client, budgetId);
  const account = response.data.account;

  const accountName = sanitizeName(account.name);
  return {
    success: true,
    message: `Account "${accountName}" created successfully`,
    account: {
      id: account.id,
      name: accountName,
      type: account.type,
      balance: money(account.balance),
      on_budget: account.on_budget,
    },
  };
}
