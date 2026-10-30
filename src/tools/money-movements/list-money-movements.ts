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
import { maskId } from '../../utils/mask.js';
import { sanitizeMemo } from '../../utils/sanitize.js';
import { budgetId, monthParam } from '../../utils/schemas.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  month: monthParam()
    .optional()
    .describe('Only return movements for this budget month: YYYY-MM-01 (first of month) or "current"'),
  group_by_group: z
    .boolean()
    .optional()
    .describe('Nest movements under their money movement group (one extra request for the groups). Default false'),
});

// Tool definition
export const listMoneyMovementsTool: Tool = {
  name: 'ynab_list_money_movements',
  description: `List money movements (moves of funds between categories) for a budget.

Use when the user asks:
- "Show me my money moves between categories"
- "When did I move money out of [category]?"
- "List my category fund transfers"
- "What money did I move in [month]?"

Returns each movement's amount (formatted, plus amount_milliunits), the categories it moved between, when it happened and who performed it (performed_by_user_id, masked). Pass month (YYYY-MM-01 or "current") to limit to a single budget month. Pass group_by_group=true to get movements nested under their money movement group (money_movement_groups[].movements, plus ungrouped_movements) instead of a flat list; it costs one extra request.`,
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
        description: 'Only return movements for this budget month: YYYY-MM-01 (first of month) or "current"',
      },
      group_by_group: {
        type: 'boolean',
        description: 'Nest movements under their money movement group (one extra request for the groups). Default false',
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

  const response =
    validated.month === undefined
      ? await client.getMoneyMovements(budgetId)
      : await client.getMoneyMovementsByMonth(budgetId, validated.month);
  const movements = response.data.money_movements;

  const formatted = movements.map((m) => ({
    id: m.id,
    amount: formatCurrency(m.amount),
    amount_milliunits: m.amount,
    month: m.month ?? null,
    moved_at: m.moved_at ?? null,
    from_category_id: m.from_category_id ?? null,
    to_category_id: m.to_category_id ?? null,
    money_movement_group_id: m.money_movement_group_id ?? null,
    performed_by_user_id: m.performed_by_user_id ? maskId(m.performed_by_user_id) : null,
    note: sanitizeMemo(m.note),
  }));

  if (!validated.group_by_group) {
    return JSON.stringify(
      {
        money_movements: formatted,
        count: formatted.length,
        month: validated.month ?? null,
      },
      null,
      2
    );
  }

  // Nested view: the flat list is replaced by groups holding their movements.
  const groupsResponse =
    validated.month === undefined
      ? await client.getMoneyMovementGroups(budgetId)
      : await client.getMoneyMovementGroupsByMonth(budgetId, validated.month);

  type Formatted = (typeof formatted)[number];
  const byGroup = new Map<string, Formatted[]>();
  const ungrouped: Formatted[] = [];
  for (const m of formatted) {
    if (m.money_movement_group_id === null) {
      ungrouped.push(m);
      continue;
    }
    const list = byGroup.get(m.money_movement_group_id);
    if (list) list.push(m);
    else byGroup.set(m.money_movement_group_id, [m]);
  }

  interface NestedGroup {
    id: string;
    month: string | null;
    group_created_at: string | null;
    note: string | null;
    performed_by_user_id: string | null;
    count: number;
    movements: Formatted[];
  }
  const nested: NestedGroup[] = groupsResponse.data.money_movement_groups
    .filter((g) => byGroup.has(g.id))
    .map((g) => ({
      id: g.id,
      month: g.month,
      group_created_at: g.group_created_at,
      note: sanitizeMemo(g.note),
      performed_by_user_id: g.performed_by_user_id ? maskId(g.performed_by_user_id) : null,
      count: byGroup.get(g.id)!.length,
      movements: byGroup.get(g.id)!,
    }));
  // Movements whose group the groups endpoint did not return still get a home.
  const known = new Set(nested.map((g) => g.id));
  for (const [id, list] of byGroup) {
    if (known.has(id)) continue;
    nested.push({
      id,
      month: list[0]?.month ?? null,
      group_created_at: null,
      note: null,
      performed_by_user_id: null,
      count: list.length,
      movements: list,
    });
  }

  return JSON.stringify(
    {
      money_movement_groups: nested,
      ungrouped_movements: ungrouped,
      count: formatted.length,
      group_count: nested.length,
      month: validated.month ?? null,
    },
    null,
    2
  );
}
