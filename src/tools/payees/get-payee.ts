/**
 * Get Payee Tool
 *
 * Returns details about a specific payee.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  payee_id: z.string().describe('The payee UUID to retrieve'),
});

// Tool definition
export const getPayeeTool: Tool = {
  name: 'ynab_get_payee',
  description: `Get details about a specific payee.

Use when the user asks:
- "Show me details for [payee]"
- "Get info on a merchant"

Requires a payee_id. Use ynab_list_payees first to find the payee ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      payee_id: {
        type: 'string',
        description: 'The payee UUID to retrieve',
      },
    },
    required: ['payee_id'],
  },
};

// Handler function
export async function handleGetPayee(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayeeById(budgetId, validated.payee_id);
  const payee = response.data.payee;

  return JSON.stringify(
    {
      payee: {
        id: payee.id,
        name: sanitizeName(payee.name),
        transfer_account_id: payee.transfer_account_id,
        deleted: payee.deleted,
      },
    },
    null,
    2
  );
}
