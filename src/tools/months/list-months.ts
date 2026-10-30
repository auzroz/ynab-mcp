/**
 * List Months Tool
 *
 * Returns all budget months.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeMemo } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  since_server_knowledge: sinceServerKnowledge(),
});

// Tool definition
export const listMonthsTool: Tool = {
  name: 'ynab_list_months',
  description: `List all budget months with summary information.

Use when the user asks:
- "Show my budget months"
- "What months do I have budgeted?"
- "List my budget history"
- "Show me past months"

Returns each month's income, budgeted, activity, and to-be-budgeted amounts.
Pass since_server_knowledge (the server_knowledge of an earlier response) to get only the months changed since then.`,
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
 * Handler for the ynab_list_months tool.
 */
export async function handleListMonths(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const cursor = validated.since_server_knowledge;
  const response =
    cursor === undefined
      ? await client.getBudgetMonths(budgetId)
      : await client.getBudgetMonths(budgetId, { lastKnowledgeOfServer: cursor });
  let months = response.data.months;
  let deletedMonths: string[] = [];
  if (cursor !== undefined) ({ changed: months, deletedIds: deletedMonths } = splitDeleted(months, (m) => m.month));

  // Use default USD formatting to preserve rate-limit budget
  // (avoids extra getBudgetSettingsById API call)
  const formattedMonths = months.map((month) => ({
    month: month.month,
    note: sanitizeMemo(month.note),
    income: formatCurrency(month.income),
    budgeted: formatCurrency(month.budgeted),
    activity: formatCurrency(month.activity),
    to_be_budgeted: formatCurrency(month.to_be_budgeted),
    age_of_money: month.age_of_money,
    deleted: month.deleted,
  }));

  if (cursor !== undefined) {
    return JSON.stringify(
      {
        delta: true,
        since_server_knowledge: cursor,
        // Months have no id; deleted ones are listed by month.
        deleted_months: deletedMonths,
        months: formattedMonths,
        count: months.length,
        note: DELTA_SUMMARY_NOTE,
        server_knowledge: response.data.server_knowledge,
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      months: formattedMonths,
      count: months.length,
      server_knowledge: response.data.server_knowledge,
    },
    null,
    2
  );
}
