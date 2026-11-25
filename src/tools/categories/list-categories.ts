/**
 * List Categories Tool
 * 
 * Returns all category groups and categories in a budget.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor, type MoneyFormatter } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, deltaFields, deltaOutputShape, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';
import { buildGoalDetail, goalDetailSchema } from '../../utils/goals.js';

const MONTH_DELTA_NOTE =
  'Budgeted, activity, balance and goal amounts are for the current month (UTC). When a new month begins they change without YNAB reporting a change, so a delta does not show it: re-read in full (omit since_server_knowledge) after a month boundary.';
import { isInternalGroup } from '../../utils/categories.js';
import { toOutputSchema } from '../output-schema.js';
import { count, milliunits, money, serverKnowledge } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  include_hidden: z
    .boolean()
    .optional()
    .describe('Whether to include hidden categories'),
  since_server_knowledge: sinceServerKnowledge(),
});

// Tool definition
const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  budgeted: money(),
  activity: money(),
  balance: money(),
  balance_raw: milliunits(),
  goal_type: z.string().nullable().describe('YNAB goal type; null without a target'),
  goal: goalDetailSchema.nullable().describe('Null when the category has no target'),
  goal_percentage_complete: z.number().nullable(),
  goal_under_funded: money().nullable(),
  goal_under_funded_raw: milliunits().nullable(),
  hidden: z.boolean(),
});

const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  hidden: z.boolean(),
  categories: z.array(categorySchema),
});

const FULL = 'Full list only';
const DELTA = 'Delta (since_server_knowledge) only';

/** What the tool returns (#45; rules in ../output-schema.ts). One object covers the full list and the delta. */
export const listCategoriesOutputSchema = z.object({
  ...deltaOutputShape,
  deleted_group_ids: z.array(z.string()).exactOptional().describe(DELTA),
  category_groups: z.array(groupSchema),
  summary: z.object({
    group_count: count().exactOptional().describe(FULL),
    category_count: count().exactOptional().describe(FULL),
    total_budgeted: money().exactOptional().describe(FULL),
    total_activity: money().exactOptional().describe(FULL),
    total_balance: money().exactOptional().describe(FULL),
    overspent_count: count().exactOptional().describe(FULL),
    underfunded_count: count().exactOptional().describe(FULL),
    changed_group_count: count().exactOptional().describe(DELTA),
    changed_category_count: count().exactOptional().describe(DELTA),
    deleted_category_count: count().exactOptional().describe(DELTA),
    deleted_group_count: count().exactOptional().describe(DELTA),
    note: z.string().exactOptional().describe(DELTA),
    month_note: z.string().exactOptional().describe(DELTA),
  }),
  alerts: z
    .object({
      overspent_categories: z.array(z.object({ name: z.string(), balance: money() })),
      underfunded_goals: z.array(z.object({ name: z.string(), under_funded: money().nullable() })),
    })
    .exactOptional()
    .describe(FULL),
  server_knowledge: serverKnowledge(),
});
export type ListCategoriesOutput = z.output<typeof listCategoriesOutputSchema>;

export const listCategoriesTool: Tool = {
  name: 'ynab_list_categories',
  description: `List all category groups and categories in a budget with budgeted amounts and balances.

Use when the user asks:
- "What categories do I have?"
- "Show my budget categories"
- "How is my budget organized?"
- "What are my spending categories?"
- "List my budget breakdown"

Returns category groups with their categories, including budgeted amounts, activity, and remaining balances.
Pass since_server_knowledge (the server_knowledge of an earlier response) to get only the groups and categories changed since then. Budgeted, activity and balance are for the current month, and a new month changes them without YNAB reporting a change, so re-read in full after a month begins.

Not possible through the YNAB API (do it in the YNAB app): target cadences other than monthly/weekly/yearly, due days, choosing the target type, and snoozing a target; hiding, unhiding, deleting or reordering categories and groups.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      include_hidden: {
        type: 'boolean',
        description: 'Whether to include hidden categories',
      },
      since_server_knowledge: sinceServerKnowledgeJsonSchema,
    },
  },
  outputSchema: toOutputSchema(listCategoriesOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_list_categories tool.
 */
export async function handleListCategories(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<ListCategoriesOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);
  const includeHidden = validated.include_hidden ?? false;
  const cursor = validated.since_server_knowledge;

  const response =
    cursor === undefined
      ? await client.getCategories(budgetId)
      : await client.getCategories(budgetId, { lastKnowledgeOfServer: cursor });
  let groups = response.data.category_groups;

  if (cursor !== undefined) return formatCategoryDelta(groups, cursor, response.data.server_knowledge, money);

  // Filter out internal category group unless explicitly including hidden
  if (!includeHidden) {
    groups = groups.filter((g) => !g.hidden && !isInternalGroup(g));
  }

  // Build response with categories grouped
  const categoryGroups = groups.map((group) => {
    let categories = group.categories;
    
    if (!includeHidden) {
      categories = categories.filter((c) => !c.hidden);
    }

    return {
      id: group.id,
      name: sanitizeName(group.name),
      hidden: group.hidden,
      categories: categories.map((cat) => ({
        id: cat.id,
        name: sanitizeName(cat.name),
        budgeted: money(cat.budgeted),
        activity: money(cat.activity),
        balance: money(cat.balance),
        balance_raw: cat.balance,
        goal_type: cat.goal_type ?? null,
        goal: buildGoalDetail(cat, money),
        goal_percentage_complete: cat.goal_percentage_complete ?? null,
        goal_under_funded:
          cat.goal_under_funded != null ? money(cat.goal_under_funded) : null,
        goal_under_funded_raw: cat.goal_under_funded ?? null,
        hidden: cat.hidden,
      })),
    };
  });

  // Calculate summary stats from the same filtered data used in detail
  // Use the filtered groups and apply the same category filter for consistency
  const allCategories = categoryGroups.flatMap((g) => g.categories);
  const filteredCategoriesRaw = groups
    .flatMap((g) => includeHidden ? g.categories : g.categories.filter((c) => !c.hidden));
  const totalBudgeted = filteredCategoriesRaw.reduce((sum, c) => sum + c.budgeted, 0);
  const totalActivity = filteredCategoriesRaw.reduce((sum, c) => sum + c.activity, 0);
  const totalBalance = filteredCategoriesRaw.reduce((sum, c) => sum + c.balance, 0);

  // Find categories with issues (using raw values for accurate filtering)
  const overspent = allCategories.filter((c) => c.balance_raw < 0);

  const underfunded = allCategories.filter((c) =>
    c.goal_under_funded_raw !== null && c.goal_under_funded_raw > 0
  );

  return {
    category_groups: categoryGroups,
    summary: {
      group_count: categoryGroups.length,
      category_count: allCategories.length,
      total_budgeted: money(totalBudgeted),
      total_activity: money(totalActivity),
      total_balance: money(totalBalance),
      overspent_count: overspent.length,
      underfunded_count: underfunded.length,
    },
    alerts: {
      overspent_categories: overspent.map((c) => ({ name: c.name, balance: c.balance })),
      underfunded_goals: underfunded.map((c) => ({ 
        name: c.name, 
        under_funded: c.goal_under_funded 
      })),
    },
    server_knowledge: response.data.server_knowledge,
  };
}

type CategoryGroups = Awaited<ReturnType<YnabClient['getCategories']>>['data']['category_groups'];

/**
 * Delta output: changed groups (with their changed categories, hidden ones
 * included) and the ids of deleted groups and categories. No totals or alerts,
 * which would only cover the changes.
 */
function formatCategoryDelta(
  groups: CategoryGroups,
  cursor: number,
  serverKnowledge: number,
  money: MoneyFormatter
): ListCategoriesOutput {
  const { changed, deletedIds: deletedGroupIds } = splitDeleted(groups, (g) => g.id);
  const deletedCategoryIds: string[] = [];
  const categoryGroups = groups
    .map((group) => {
      const { changed: categories, deletedIds } = splitDeleted(group.categories, (c) => c.id);
      deletedCategoryIds.push(...deletedIds);
      return { group, categories };
    })
    .filter(({ group }) => changed.includes(group))
    .map(({ group, categories }) => ({
      id: group.id,
      name: sanitizeName(group.name),
      hidden: group.hidden,
      categories: categories.map((cat) => ({
        id: cat.id,
        name: sanitizeName(cat.name),
        budgeted: money(cat.budgeted),
        activity: money(cat.activity),
        balance: money(cat.balance),
        balance_raw: cat.balance,
        goal_type: cat.goal_type ?? null,
        goal: buildGoalDetail(cat, money),
        goal_percentage_complete: cat.goal_percentage_complete ?? null,
        goal_under_funded:
          cat.goal_under_funded != null ? money(cat.goal_under_funded) : null,
        goal_under_funded_raw: cat.goal_under_funded ?? null,
        hidden: cat.hidden,
      })),
    }));
  return {
    ...deltaFields(cursor, deletedCategoryIds),
    deleted_group_ids: deletedGroupIds,
    category_groups: categoryGroups,
    summary: {
      changed_group_count: categoryGroups.length,
      changed_category_count: categoryGroups.reduce((n, g) => n + g.categories.length, 0),
      deleted_category_count: deletedCategoryIds.length,
      deleted_group_count: deletedGroupIds.length,
      note: DELTA_SUMMARY_NOTE,
      month_note: MONTH_DELTA_NOTE,
    },
    server_knowledge: serverKnowledge,
  };
}
