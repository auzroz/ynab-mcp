/**
 * Update Category Details Tool
 *
 * Renames a category, changes its note, moves it to another category group,
 * and sets or clears its target (goal) fields. Uses PATCH
 * /plans/{plan_id}/categories/{category_id}. This is distinct from
 * ynab_update_category, which only changes a month's budgeted amount.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { NAME_MAX_LENGTH, NOTE_MAX_LENGTH, budgetId, ynabId } from '../../utils/schemas.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';
import { isInternalGroup } from '../../utils/categories.js';
import { ValidationError, ReadOnlyModeError } from '../../utils/errors.js';
import { formatCurrency } from '../../utils/milliunits.js';
import {
  categoryTargetUpdateShape,
  categoryTargetUpdateJsonProperties,
  pickCategoryTargets,
  CATEGORY_TARGET_FIELDS,
  refineGoalFrequency,
} from './category-targets.js';

const UPDATABLE_FIELDS = ['name', 'note', 'category_group_id', ...CATEGORY_TARGET_FIELDS] as const;

// Input schema
const inputSchema = z
  .object({
    budget_id: budgetId()
      .optional()
      .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
    category_id: ynabId().describe('The category UUID to update'),
    name: z.string().min(1).max(NAME_MAX_LENGTH).optional().describe('New name for the category'),
    note: z
      .string()
      .max(NOTE_MAX_LENGTH)
      .nullable()
      .optional()
      .describe('New note for the category. Pass null or an empty string to clear the note'),
    category_group_id: ynabId()
      .optional()
      .describe('UUID of the category group to move the category into'),
    ...categoryTargetUpdateShape,
  })
  .superRefine(refineGoalFrequency)
  .refine((v) => UPDATABLE_FIELDS.some((f) => v[f] !== undefined), {
    message: `Provide at least one field to update: ${UPDATABLE_FIELDS.join(', ')}`,
  });

// Tool definition
export const updateCategoryDetailsTool: Tool = {
  name: 'ynab_update_category_details',
  description: `Update a category's details: rename it, change its note, move it to a different category group, or set/clear its target (goal).

Use when the user asks:
- "Rename my [category] category to X"
- "Add a note to [category]" or "Clear the note on [category]"
- "Move [category] to the [group] group"
- "Set a $200 monthly target on [category]" or "Remove the target from [category]"
- "Set a $50 weekly target for Dining Out" (goal_target 50 + goal_frequency "weekly")

Provide at least one of name, note, category_group_id, goal_target (in dollars, e.g. 200 for $200), goal_target_date, goal_needs_whole_amount, goal_frequency (monthly|weekly|yearly; recurring target, requires goal_target, not combinable with goal_target_date). Target fields accept null to remove the existing value; note accepts null or "" to clear it. Moving into YNAB's internal category group is rejected.

Requires a category_id (and a category_group_id when moving). Use ynab_list_categories first to find the IDs.

To change how much is budgeted for a category in a given month, use ynab_update_category instead; this tool never changes budgeted amounts.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
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
        description: 'The category UUID to update',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: NAME_MAX_LENGTH,
        description: 'New name for the category',
      },
      note: {
        type: ['string', 'null'],
        maxLength: NOTE_MAX_LENGTH,
        description: 'New note for the category. Pass null or an empty string to clear the note',
      },
      category_group_id: {
        type: 'string',
        maxLength: 36,
        description: 'UUID of the category group to move the category into',
      },
      ...categoryTargetUpdateJsonProperties,
    },
    required: ['category_id'],
  },
};

/**
 * Handler for the ynab_update_category_details tool.
 */
export async function handleUpdateCategoryDetails(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Fail fast in read-only sessions before any API read is spent.
  if (client.isReadOnly()) {
    throw new ReadOnlyModeError('updateCategory');
  }

  // Reject moves into YNAB-internal groups. getCategories is cached, so this
  // usually costs no API request.
  if (validated.category_group_id !== undefined) {
    const groups = (await client.getCategories(budgetId)).data.category_groups;
    const target = groups.find((g) => g.id === validated.category_group_id);
    if (target && isInternalGroup(target)) {
      throw new ValidationError('Cannot move a category into an internal category group');
    }
  }

  const response = await client.updateCategory(budgetId, validated.category_id, {
    category: {
      ...(validated.name !== undefined ? { name: validated.name } : {}),
      ...(validated.note !== undefined ? { note: validated.note === '' ? null : validated.note } : {}),
      ...(validated.category_group_id !== undefined
        ? { category_group_id: validated.category_group_id }
        : {}),
      ...pickCategoryTargets(validated),
    },
  });

  const category = response.data.category;
  const categoryName = sanitizeName(category.name);
  const updated = UPDATABLE_FIELDS.filter((f) => validated[f] !== undefined);

  return JSON.stringify(
    {
      success: true,
      message: `Category "${categoryName}" updated`,
      updated_fields: updated,
      category: {
        id: category.id,
        name: categoryName,
        category_group_id: category.category_group_id,
        note: sanitizeMemo(category.note),
        goal_target: category.goal_target ?? null,
        goal_target_display:
          category.goal_target != null ? formatCurrency(category.goal_target) : null,
        goal_target_date: category.goal_target_date ?? null,
        goal_needs_whole_amount: category.goal_needs_whole_amount ?? null,
      },
    },
    null,
    2
  );
}
