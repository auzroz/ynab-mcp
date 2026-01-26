/**
 * List Payees Tool
 *
 * Returns all payees in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const listPayeesTool: Tool = {
  name: 'ynab_list_payees',
  description: `List all payees in a budget.

Use when the user asks:
- "Show my payees"
- "List all merchants"
- "Who have I paid?"
- "Find a payee"

Returns payee names and IDs. Payees are merchants, people, or places you transact with.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
  },
};

// Handler function
/**
 * Handler for the ynab_list_payees tool.
 */
export async function handleListPayees(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayees(budgetId);
  const payees = response.data.payees;

  // Filter out deleted payees and sort by name
  const activePayees = payees
    .filter((p) => !p.deleted)
    .sort((a, b) => a.name.localeCompare(b.name));

  const formattedPayees = activePayees.map((payee) => ({
    id: sanitizeString(payee.id) ?? '',
    name: sanitizeName(payee.name),
    transfer_account_id: payee.transfer_account_id ? sanitizeString(payee.transfer_account_id) : null,
  }));

  // Separate transfer payees from regular payees
  const transferPayees = formattedPayees.filter((p) => p.transfer_account_id != null);
  const regularPayees = formattedPayees.filter((p) => p.transfer_account_id == null);

  return JSON.stringify(
    {
      payees: regularPayees,
      transfer_payees: transferPayees,
      summary: {
        total_payees: formattedPayees.length,
        regular_payees: regularPayees.length,
        transfer_payees: transferPayees.length,
      },
    },
    null,
    2
  );
}
