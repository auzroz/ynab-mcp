/**
 * Create Account Tool
 *
 * Creates a new account in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// YNAB account types (must match ynab.AccountType enum values)
const accountTypes = [
  'checking',
  'savings',
  'cash',
  'creditCard',
  'lineOfCredit',
  'otherAsset',
  'otherLiability',
  'mortgage',
  'autoLoan',
  'studentLoan',
  'personalLoan',
  'medicalDebt',
  'otherDebt',
] as const;

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  name: z.string().min(1).max(100).describe('The name of the account'),
  type: z
    .enum(accountTypes)
    .describe('The type of account (checking, savings, creditCard, etc.)'),
  balance: z
    .number()
    .describe('The starting balance in dollars (e.g., 1000.50 for $1,000.50)'),
});

// Tool definition
export const createAccountTool: Tool = {
  name: 'ynab_create_account',
  description: `Create a new account in a budget.

Use when the user asks:
- "Add a new checking account"
- "Create a savings account"
- "I want to add my credit card to YNAB"
- "Set up a new account with balance X"

Account types: checking, savings, cash, creditCard, lineOfCredit, otherAsset, otherLiability, mortgage, autoLoan, studentLoan, personalLoan, medicalDebt, otherDebt

Balance should be provided in dollars (e.g., 1000.50). For credit cards and debt accounts, use a negative balance for amounts owed.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      name: {
        type: 'string',
        description: 'The name of the account',
      },
      type: {
        type: 'string',
        enum: accountTypes,
        description: 'The type of account',
      },
      balance: {
        type: 'number',
        description: 'The starting balance in dollars (e.g., 1000.50)',
      },
    },
    required: ['name', 'type', 'balance'],
  },
};

// Handler function
export async function handleCreateAccount(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.createAccount(budgetId, {
    account: {
      name: validated.name,
      type: validated.type as unknown as ynab.AccountType,
      balance: toMilliunits(validated.balance),
    },
  });

  const account = response.data.account;

  const accountName = sanitizeName(account.name);
  return JSON.stringify(
    {
      success: true,
      message: `Account "${accountName}" created successfully`,
      account: {
        id: account.id,
        name: accountName,
        type: account.type,
        balance: formatCurrency(account.balance),
        on_budget: account.on_budget,
      },
    },
    null,
    2
  );
}
