/**
 * Get Payee Tool
 *
 * Returns details about a specific payee.
 */

import { z } from 'zod';
import { budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';
import { toOutputSchema } from '../output-schema.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  payee_id: ynabId().describe('The payee UUID to retrieve'),
});

// Tool definition
/** What the tool returns (#45; rules in ../output-schema.ts). */
export const getPayeeOutputSchema = z.object({
  payee: z.object({
    id: z.string(),
    name: z.string(),
    transfer_account_id: z.string().nullable().describe('The account a transfer payee transfers to; null for other payees'),
    deleted: z.boolean(),
  }),
});
export type GetPayeeOutput = z.output<typeof getPayeeOutputSchema>;

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
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      payee_id: {
        type: 'string',
        maxLength: 36,
        description: 'The payee UUID to retrieve',
      },
    },
    required: ['payee_id'],
  },
  outputSchema: toOutputSchema(getPayeeOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_get_payee tool.
 */
export async function handleGetPayee(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<GetPayeeOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayeeById(budgetId, validated.payee_id);
  const payee = response.data.payee;

  return {
    payee: {
      id: sanitizeString(payee.id) ?? '',
      name: sanitizeName(payee.name),
      transfer_account_id: payee.transfer_account_id ? sanitizeString(payee.transfer_account_id) : null,
      deleted: payee.deleted,
    },
  };
}
