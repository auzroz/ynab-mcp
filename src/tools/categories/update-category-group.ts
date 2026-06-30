/**
 * Update Category Group Tool
 *
 * Renames an existing category group.
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
  category_group_id: z.string().uuid().describe('The category group UUID to update'),
  name: z.string().min(1).max(500).describe('The new name for the category group'),
});

// Tool definition
export const updateCategoryGroupTool: Tool = {
  name: 'ynab_update_category_group',
  description: `Rename an existing category group.

Use when the user asks:
- "Rename the [group] category group"
- "Change the name of my budgeting section"

Requires a category_group_id. Use ynab_list_categories first to find the group ID.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      category_group_id: {
        type: 'string',
        description: 'The category group UUID to update',
      },
      name: {
        type: 'string',
        description: 'The new name for the category group',
      },
    },
    required: ['category_group_id', 'name'],
  },
};

// Handler function
/**
 * Handler for the ynab_update_category_group tool.
 */
export async function handleUpdateCategoryGroup(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.updateCategoryGroup(budgetId, validated.category_group_id, {
    category_group: { name: validated.name },
  });

  const group = response.data.category_group;

  return JSON.stringify(
    {
      success: true,
      message: `Category group renamed to "${sanitizeName(group.name)}"`,
      category_group: {
        id: group.id,
        name: sanitizeName(group.name),
      },
    },
    null,
    2
  );
}
