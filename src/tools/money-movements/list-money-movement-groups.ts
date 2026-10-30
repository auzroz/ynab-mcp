/**
 * List Money Movement Groups Tool
 *
 * Lists money movement groups (batches of category-to-category moves made
 * together) for a budget, optionally limited to one budget month.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { maskId } from '../../utils/mask.js';
import { sanitizeMemo } from '../../utils/sanitize.js';
import { budgetId, monthParam } from '../../utils/schemas.js';

const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: monthParam()
    .optional()
    .describe('Only return groups for this budget month: YYYY-MM-01 (first of month) or "current"'),
});

export const listMoneyMovementGroupsTool: Tool = {
  name: 'ynab_list_money_movement_groups',
  description: `List money movement groups: batches of category-to-category fund moves that were made together.

Use when the user asks:
- "Which budget rebalancing batches did I do?"
- "Show my money move groups for [month]"
- "What were the notes on my category fund moves?"

Each group has an id, creation time, month, note and who performed it (performed_by_user_id, masked). Use the group id to match entries from ynab_list_money_movements (money_movement_group_id). Pass month (YYYY-MM-01 or "current") to limit to one budget month.`,
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
        description: 'Only return groups for this budget month: YYYY-MM-01 (first of month) or "current"',
      },
    },
  },
};

/**
 * Handler for the ynab_list_money_movement_groups tool.
 */
export async function handleListMoneyMovementGroups(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const resolvedBudgetId = client.resolveBudgetId(validated.budget_id);

  const response =
    validated.month === undefined
      ? await client.getMoneyMovementGroups(resolvedBudgetId)
      : await client.getMoneyMovementGroupsByMonth(resolvedBudgetId, validated.month);

  const groups = response.data.money_movement_groups.map((g) => ({
    id: g.id,
    month: g.month,
    group_created_at: g.group_created_at,
    note: sanitizeMemo(g.note),
    has_performed_by_user: !!g.performed_by_user_id,
    performed_by_user_id: g.performed_by_user_id ? maskId(g.performed_by_user_id) : null,
  }));

  return JSON.stringify(
    {
      money_movement_groups: groups,
      count: groups.length,
      month: validated.month ?? null,
    },
    null,
    2
  );
}
