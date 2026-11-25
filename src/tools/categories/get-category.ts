/**
 * Get Category Tool
 *
 * Returns details about a specific category.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import { budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { buildGoalDetail, goalDetailSchema } from '../../utils/goals.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import { omitNull } from '../../utils/omit-null.js';
import { toOutputSchema } from '../output-schema.js';
import { money } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  category_id: ynabId().describe('The category UUID to retrieve'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const getCategoryOutputSchema = z.object({
  category: z.object({
    id: z.string(),
    category_group_id: z.string(),
    name: z.string(),
    hidden: z.boolean(),
    note: z.string().nullable(),
    budgeted: money(),
    activity: money(),
    balance: money(),
    goal: goalDetailSchema.nullable().describe('Null when the category has no target'),
    original_category_group_id: z.string().exactOptional().describe('Omitted unless the category was moved'),
    deleted: z.boolean(),
  }),
});
export type GetCategoryOutput = z.output<typeof getCategoryOutputSchema>;

// Tool definition
export const getCategoryTool: Tool = {
  name: 'ynab_get_category',
  description: `Get details about a specific budget category including budgeted amount, activity, and goal status.

Use when the user asks:
- "Show me details for my Groceries category"
- "What's the balance in [category name]?"
- "How much is budgeted for [category]?"
- "What's my goal progress for [category]?"

Requires a category_id. Use ynab_list_categories first to find the category ID.

Not possible through the YNAB API (do it in the YNAB app): target cadences other than monthly/weekly/yearly, due days, choosing the target type, and snoozing a target.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      category_id: {
        type: 'string',
        maxLength: 36,
        description: 'The category UUID to retrieve',
      },
    },
    required: ['category_id'],
  },
  outputSchema: toOutputSchema(getCategoryOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_get_category tool.
 */
export async function handleGetCategory(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<GetCategoryOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);

  const response = await client.getCategoryById(budgetId, validated.category_id);
  const category = response.data.category;

  return {
    category: {
      id: category.id,
      category_group_id: category.category_group_id,
      name: sanitizeName(category.name),
      hidden: category.hidden,
      note: sanitizeMemo(category.note),
      budgeted: money(category.budgeted),
      activity: money(category.activity),
      balance: money(category.balance),
      goal: buildGoalDetail(category, money),
      ...omitNull({ original_category_group_id: category.original_category_group_id }),
      deleted: category.deleted,
    },
  };
}
