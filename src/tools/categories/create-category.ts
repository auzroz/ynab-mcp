/**
 * Create Category Tool
 *
 * Creates a new category within an existing category group.
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
  category_group_id: z
    .string()
    .uuid()
    .describe('The UUID of the category group to add the category to'),
  name: z.string().min(1).max(500).describe('The name of the new category'),
  note: z.string().max(500).optional().describe('Optional note for the category'),
});

// Tool definition
export const createCategoryTool: Tool = {
  name: 'ynab_create_category',
  description: `Create a new category inside an existing category group.

Use when the user asks:
- "Add a new category called X to my [group] group"
- "Create a budgeting category for Y"

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
        description: 'The UUID of the category group to add the category to',
      },
      name: {
        type: 'string',
        description: 'The name of the new category',
      },
      note: {
        type: 'string',
        description: 'Optional note for the category',
      },
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
      },
    },
    null,
    2
  );
}
