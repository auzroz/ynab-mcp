/**
 * Get Account Tool
 *
 * Returns details about a specific account.
 */

import { z } from 'zod';
import { budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { accountDetailFields } from './account-fields.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  account_id: ynabId().describe('The account UUID to retrieve'),
});

// Tool definition
export const getAccountTool: Tool = {
  name: 'ynab_get_account',
  description: `Get details about a specific account including balance and recent activity.

Use when the user asks:
- "Show me details for my checking account"
- "What's the balance of [account name]?"
- "Tell me about my savings account"
- "Get info on a specific account"

Also returns transfer_payee_id: set it as payee_id on ynab_create_transaction to record a transfer into this account.

Requires an account_id. Use ynab_list_accounts first to find the account ID.

Not possible through the YNAB API (do it in the YNAB app): editing, closing or reopening an account, setting up loan accounts, and changing interest rates.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      account_id: {
        type: 'string',
        maxLength: 36,
        description: 'The account UUID to retrieve',
      },
    },
    required: ['account_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_get_account tool.
 */
export async function handleGetAccount(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getAccountById(budgetId, validated.account_id);
  const account = response.data.account;

  return JSON.stringify(
    {
      account: {
        id: account.id,
        name: sanitizeName(account.name),
        type: account.type,
        balance: formatCurrency(account.balance),
        cleared_balance: formatCurrency(account.cleared_balance),
        uncleared_balance: formatCurrency(account.uncleared_balance),
        ...accountDetailFields(account, { includeEmptyMaps: true }),
      },
    },
    null,
    2
  );
}
