/**
 * List Months Tool
 *
 * Returns all budget months.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { sanitizeMemo } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, deltaOutputShape, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';
import { omitNull } from '../../utils/omit-null.js';
import { toOutputSchema } from '../output-schema.js';
import { count, money, serverKnowledge } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  since_server_knowledge: sinceServerKnowledge(),
});

const DELTA = 'Delta (since_server_knowledge) only';

/** What the tool returns (#45; rules in ../output-schema.ts). One object covers the full list and the delta. */
export const listMonthsOutputSchema = z.object({
  delta: deltaOutputShape.delta,
  since_server_knowledge: deltaOutputShape.since_server_knowledge,
  deleted_months: z.array(z.string()).exactOptional().describe(`${DELTA}: months have no id, so deleted ones are listed by month`),
  months: z.array(
    z.object({
      month: z.string(),
      note: z.string().nullable(),
      income: money(),
      budgeted: money(),
      activity: money(),
      to_be_budgeted: money(),
      age_of_money: z.number().int().exactOptional().describe('Days; omitted when YNAB has no value'),
      deleted: z.boolean(),
    })
  ),
  count: count(),
  note: z.string().exactOptional().describe(DELTA),
  server_knowledge: serverKnowledge(),
});
export type ListMonthsOutput = z.output<typeof listMonthsOutputSchema>;

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
Pass since_server_knowledge (the server_knowledge of an earlier response) to get only the months changed since then.

${UNTRUSTED_TEXT_NOTE}`,
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
  outputSchema: toOutputSchema(listMonthsOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_list_months tool.
 */
export async function handleListMonths(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<ListMonthsOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);

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
    income: money(month.income),
    budgeted: money(month.budgeted),
    activity: money(month.activity),
    to_be_budgeted: money(month.to_be_budgeted),
    ...omitNull({ age_of_money: month.age_of_money }),
    deleted: month.deleted,
  }));

  if (cursor !== undefined) {
    return {
      delta: true,
      since_server_knowledge: cursor,
      // Months have no id; deleted ones are listed by month.
      deleted_months: deletedMonths,
      months: formattedMonths,
      count: months.length,
      note: DELTA_SUMMARY_NOTE,
      server_knowledge: response.data.server_knowledge,
    };
  }

  return {
    months: formattedMonths,
    count: months.length,
    server_knowledge: response.data.server_knowledge,
  };
}
