/**
 * Create Payee Tool
 *
 * Creates a new payee.
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
  name: z.string().min(1).max(500).describe('The name of the new payee'),
});

// Tool definition
export const createPayeeTool: Tool = {
  name: 'ynab_create_payee',
  description: `Create a new payee.

Use when the user asks:
- "Add a payee called X"
- "Create a new merchant"

Most of the time payees are created automatically when you add a transaction with a
new payee_name. Use this tool when you need a payee to exist ahead of time.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      name: {
        type: 'string',
        description: 'The name of the new payee',
      },
    },
    required: ['name'],
  },
};

// Handler function
/**
 * Handler for the ynab_create_payee tool.
 */
export async function handleCreatePayee(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.createPayee(budgetId, {
    payee: { name: validated.name },
  });

  const payee = response.data.payee;

  return JSON.stringify(
    {
      success: true,
      message: `Payee "${sanitizeName(payee.name)}" created successfully`,
      payee: {
        id: payee.id,
        name: sanitizeName(payee.name),
      },
    },
    null,
    2
  );
}
