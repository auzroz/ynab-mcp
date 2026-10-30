/**
 * List Payees Tool
 *
 * Returns all payees in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeName, sanitizeString } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, deltaFields, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  since_server_knowledge: sinceServerKnowledge(),
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

Returns payee names and IDs. Payees are merchants, people, or places you transact with.
Pass since_server_knowledge (the server_knowledge of an earlier response) to get only the payees changed since then.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      since_server_knowledge: sinceServerKnowledgeJsonSchema,
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

  const cursor = validated.since_server_knowledge;
  const response =
    cursor === undefined
      ? await client.getPayees(budgetId)
      : await client.getPayees(budgetId, { lastKnowledgeOfServer: cursor });
  const { changed, deletedIds } = splitDeleted(response.data.payees, (p) => sanitizeString(p.id) ?? '');

  // Filter out deleted payees and sort by name
  const activePayees = changed.sort((a, b) => a.name.localeCompare(b.name));

  const formattedPayees = activePayees.map((payee) => ({
    id: sanitizeString(payee.id) ?? '',
    name: sanitizeName(payee.name),
    transfer_account_id: payee.transfer_account_id ? sanitizeString(payee.transfer_account_id) : null,
  }));

  // Separate transfer payees from regular payees
  const transferPayees = formattedPayees.filter((p) => p.transfer_account_id != null);
  const regularPayees = formattedPayees.filter((p) => p.transfer_account_id == null);

  if (cursor !== undefined) {
    return JSON.stringify(
      {
        ...deltaFields(cursor, deletedIds),
        payees: regularPayees,
        transfer_payees: transferPayees,
        summary: {
          changed_count: formattedPayees.length,
          deleted_count: deletedIds.length,
          note: DELTA_SUMMARY_NOTE,
        },
        server_knowledge: response.data.server_knowledge,
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      payees: regularPayees,
      transfer_payees: transferPayees,
      summary: {
        total_payees: formattedPayees.length,
        regular_payees: regularPayees.length,
        transfer_payees: transferPayees.length,
      },
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
