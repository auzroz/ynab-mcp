/**
 * Create Category Group Tool
 *
 * Creates a new category group.
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
  name: z.string().min(1).max(500).describe('The name of the new category group'),
});

// Tool definition
export const createCategoryGroupTool: Tool = {
  name: 'ynab_create_category_group',
  description: `Create a new category group.

Use when the user asks:
- "Add a new category group called X"
- "Create a top-level budgeting section for Y"

Category groups organize related categories (e.g., "Monthly Bills", "Fun Money").
After creating a group, use ynab_create_category to add categories to it.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      name: {
        type: 'string',
        description: 'The name of the new category group',
      },
    },
    required: ['name'],
  },
};

// Handler function
/**
 * Handler for the ynab_create_category_group tool.
 */
export async function handleCreateCategoryGroup(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.createCategoryGroup(budgetId, {
    category_group: { name: validated.name },
  });

  const group = response.data.category_group;

  return JSON.stringify(
    {
      success: true,
      message: `Category group "${sanitizeName(group.name)}" created successfully`,
      category_group: {
        id: group.id,
        name: sanitizeName(group.name),
      },
    },
    null,
    2
  );
}
