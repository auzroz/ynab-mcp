/**
 * Update Payee Tool
 *
 * Renames an existing payee.
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
  payee_id: z.string().uuid().describe('The payee UUID to update'),
  name: z.string().min(1).max(500).describe('The new name for the payee'),
});

// Tool definition
export const updatePayeeTool: Tool = {
  name: 'ynab_update_payee',
  description: `Rename an existing payee.

Use when the user asks:
- "Rename payee X to Y"
- "Fix the name of this payee"
- "Clean up this merchant name"

Requires a payee_id. Use ynab_list_payees first to find the payee ID.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      payee_id: {
        type: 'string',
        description: 'The payee UUID to update',
      },
      name: {
        type: 'string',
        description: 'The new name for the payee',
      },
    },
    required: ['payee_id', 'name'],
  },
};

// Handler function
/**
 * Handler for the ynab_update_payee tool.
 */
export async function handleUpdatePayee(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.updatePayee(budgetId, validated.payee_id, {
    payee: { name: validated.name },
  });

  const payee = response.data.payee;

  return JSON.stringify(
    {
      success: true,
      message: `Payee renamed to "${sanitizeName(payee.name)}"`,
      payee: {
        id: payee.id,
        name: sanitizeName(payee.name),
      },
    },
    null,
    2
  );
}
