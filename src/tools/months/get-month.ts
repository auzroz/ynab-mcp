/**
 * Get Month Tool
 *
 * Returns detailed information about a specific budget month.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { omitNull } from '../../utils/omit-null.js';
import { toOutputSchema } from '../output-schema.js';
import { count, fromYnab, money } from '../schemas/common.js';

// Input schema - accepts YYYY-MM-DD format or "current"
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: z
    .string()
    .max(10)
    .refine(
      (val) => val === 'current' || /^\d{4}-\d{2}-\d{2}$/.test(val),
      { message: 'Month must be in YYYY-MM-DD format or "current"' }
    )
    .describe('The budget month in YYYY-MM-DD format (use first of month) or "current"'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const getMonthOutputSchema = z.object({
  month: fromYnab(z.string()),
  summary: z.object({
    note: z.string().nullable(),
    income: money(),
    budgeted: money(),
    activity: money(),
    to_be_budgeted: money(),
    age_of_money: z.number().int().exactOptional().describe('Days; omitted when YNAB has no value'),
  }),
  category_count: count(),
  categories_by_group: z.array(
    z.object({
      group_id: fromYnab(z.string()),
      group_name: z.string(),
      categories: z.array(z.object({ name: z.string(), budgeted: money(), activity: money(), balance: money() })),
    })
  ),
});
export type GetMonthOutput = z.output<typeof getMonthOutputSchema>;

// Tool definition
export const getMonthTool: Tool = {
  name: 'ynab_get_month',
  description: `Get detailed information about a specific budget month including all categories.

Use when the user asks:
- "Show me January's budget"
- "What did I budget last month?"
- "Give me details for [month]"
- "How much did I have to budget in [month]?"

Use first-of-month format for the month parameter (e.g., 2024-01-01 for January 2024).
Use "current" for the current month.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      month: {
        type: 'string',
        maxLength: 10,
        description:
          'The budget month in YYYY-MM-DD format (use first of month, or "current")',
      },
    },
    required: ['month'],
  },
  outputSchema: toOutputSchema(getMonthOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_get_month tool.
 */
export async function handleGetMonth(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<GetMonthOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);

  // Convert "current" to actual month date
  const monthParam = validated.month === 'current' ? getCurrentMonth() : validated.month;

  // Fetch month data and categories in parallel
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, monthParam),
    client.getCategories(budgetId),
  ]);

  const month = monthResponse.data.month;

  // Build category group lookup (id -> {id, name})
  const groupLookup = new Map<string, { id: string; name: string }>();
  for (const group of categoriesResponse.data.category_groups) {
    groupLookup.set(group.id, { id: group.id, name: group.name });
  }

  // Category type for group entries
  type CategoryInfo = {
    name: string;
    budgeted: string;
    activity: string;
    balance: string;
  };

  // Group categories using Map keyed by group_id (safe internal key)
  const groupMap = new Map<string, { group_id: string; group_name: string; categories: CategoryInfo[] }>();

  for (const category of month.categories) {
    if (category.hidden) continue;

    const groupId = category.category_group_id;
    const groupInfo = groupLookup.get(groupId);
    const groupName = sanitizeName(groupInfo?.name ?? 'Other');

    let groupEntry = groupMap.get(groupId);
    if (groupEntry === undefined) {
      groupEntry = {
        group_id: groupId,
        group_name: groupName,
        categories: [],
      };
      groupMap.set(groupId, groupEntry);
    }
    groupEntry.categories.push({
      name: sanitizeName(category.name),
      budgeted: money(category.budgeted),
      activity: money(category.activity),
      balance: money(category.balance),
    });
  }

  // Convert to array and sort alphabetically by group name
  const categoriesByGroup = Array.from(groupMap.values()).sort((a, b) =>
    a.group_name.localeCompare(b.group_name)
  );

  return {
    month: month.month,
    summary: {
      note: sanitizeMemo(month.note),
      income: money(month.income),
      budgeted: money(month.budgeted),
      activity: money(month.activity),
      to_be_budgeted: money(month.to_be_budgeted),
      ...omitNull({ age_of_money: month.age_of_money }),
    },
    category_count: month.categories.filter((c) => !c.hidden).length,
    categories_by_group: categoriesByGroup,
  };
}
