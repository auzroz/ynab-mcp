/**
 * Create Category Tool
 *
 * Creates a new category within an existing category group.
 */

import { z } from 'zod';
import { NAME_MAX_LENGTH, NOTE_MAX_LENGTH, budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { formatCurrency } from '../../utils/milliunits.js';
import {
  categoryTargetCreateShape,
  categoryTargetCreateJsonProperties,
  pickCategoryTargets,
  refineGoalFrequency,
} from './category-targets.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  category_group_id: ynabId()
    .describe('The UUID of the category group to add the category to'),
  name: z.string().min(1).max(NAME_MAX_LENGTH).describe('The name of the new category'),
  note: z.string().max(NOTE_MAX_LENGTH).optional().describe('Optional note for the category'),
  ...categoryTargetCreateShape,
}).superRefine(refineGoalFrequency);

// Tool definition
export const createCategoryTool: Tool = {
  name: 'ynab_create_category',
  description: `Create a new category inside an existing category group.

Use when the user asks:
- "Add a new category called X to my [group] group"
- "Create a budgeting category for Y"

Requires a category_group_id. Use ynab_list_categories first to find the group ID.

Optionally set a target (goal) at creation: goal_target (in dollars, e.g. 200 for $200), goal_target_date (YYYY-MM-DD) and goal_needs_whole_amount. Supplying goal_target creates a monthly spending target. Add goal_frequency (monthly, weekly or yearly) with goal_target for a recurring "set aside" target (e.g. "Create Dining Out with a $50 weekly target" = goal_target 50, goal_frequency weekly); it cannot be combined with goal_target_date.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.

Not possible through the YNAB API (do it in the YNAB app): hiding, unhiding, deleting or reordering categories, target cadences other than monthly/weekly/yearly, due days, choosing the target type, and snoozing a target.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      category_group_id: {
        type: 'string',
        maxLength: 36,
        description: 'The UUID of the category group to add the category to',
      },
      name: {
        type: 'string',
        maxLength: 200,
        description: 'The name of the new category',
      },
      note: {
        type: 'string',
        maxLength: 500,
        description: 'Optional note for the category',
      },
      ...categoryTargetCreateJsonProperties,
    },
    required: ['category_group_id', 'name'],
  },
};

// Handler function
/**
 * Handler for the ynab_create_category tool.
 */
export async function handleCreateCategory(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.createCategory(budgetId, {
    category: {
      name: validated.name,
      category_group_id: validated.category_group_id,
      ...(validated.note !== undefined ? { note: validated.note } : {}),
      ...pickCategoryTargets(validated),
    },
  });

  const category = response.data.category;

  return JSON.stringify(
    {
      success: true,
      message: `Category "${sanitizeName(category.name)}" created successfully`,
      category: {
        id: category.id,
        name: sanitizeName(category.name),
        category_group_id: category.category_group_id,
        goal_target: category.goal_target ?? null,
        goal_target_display:
          category.goal_target != null ? formatCurrency(category.goal_target) : null,
      },
    },
    null,
    2
  );
}
