/**
 * List Money Movements Tool
 *
 * Lists money movements (category-to-category fund moves) for a budget.
 * Money movements are a YNAB feature exposed by API v1.83+ / ynab SDK v4.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const listMoneyMovementsTool: Tool = {
  name: 'ynab_list_money_movements',
  description: `List money movements (moves of funds between categories) for a budget.

Use when the user asks:
- "Show me my money moves between categories"
- "When did I move money out of [category]?"
- "List my category fund transfers"

Returns each movement's amount, the categories it moved between, and when it happened.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
  },
};

// Handler function
/**
 * Handler for the ynab_list_money_movements tool.
 */
export async function handleListMoneyMovements(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getMoneyMovements(budgetId);
  const movements = response.data.money_movements;

  const formatted = movements.map((m) => ({
    id: m.id,
    amount: formatCurrency(m.amount),
    month: m.month ?? null,
    moved_at: m.moved_at ?? null,
    from_category_id: m.from_category_id ?? null,
    to_category_id: m.to_category_id ?? null,
    money_movement_group_id: m.money_movement_group_id ?? null,
    note: sanitizeMemo(m.note),
  }));

  return JSON.stringify(
    {
      money_movements: formatted,
      count: formatted.length,
    },
    null,
    2
  );
}
