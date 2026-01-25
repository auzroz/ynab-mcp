/**
 * Get Account Tool
 *
 * Returns details about a specific account.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  account_id: z.string().describe('The account UUID to retrieve'),
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

Requires an account_id. Use ynab_list_accounts first to find the account ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      account_id: {
        type: 'string',
        description: 'The account UUID to retrieve',
      },
    },
    required: ['account_id'],
  },
};

// Handler function
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
        on_budget: account.on_budget,
        closed: account.closed,
        note: sanitizeMemo(account.note),
        balance: formatCurrency(account.balance),
        cleared_balance: formatCurrency(account.cleared_balance),
        uncleared_balance: formatCurrency(account.uncleared_balance),
        transfer_payee_id: account.transfer_payee_id,
        direct_import_linked: account.direct_import_linked,
        direct_import_in_error: account.direct_import_in_error,
        last_reconciled_at: account.last_reconciled_at,
        debt_original_balance:
          account.debt_original_balance != null
            ? formatCurrency(account.debt_original_balance)
            : null,
        debt_interest_rates: account.debt_interest_rates,
        debt_minimum_payments: account.debt_minimum_payments,
        debt_escrow_amounts: account.debt_escrow_amounts,
      },
    },
    null,
    2
  );
}
