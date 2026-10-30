/**
 * Move Money Tool
 *
 * Convenience write tool: shifts budgeted money from one category to another
 * in a single month by adjusting both categories' budgeted amounts.
 *
 * The YNAB API has no money-movement write endpoint, so this does NOT create a
 * money-movement record (those only appear when YNAB's own apps move money).
 * It performs two budgeted-amount updates and, if the second one fails, tries
 * to restore the first.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { addMilliunits, formatCurrency, subtractMilliunits, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { budgetId, monthParam, ynabId, MONTH_MAX_LENGTH } from '../../utils/schemas.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { formatErrorResponse } from '../../utils/errors.js';

// Input schema
const inputSchema = z
  .object({
    budget_id: budgetId()
      .optional()
      .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
    month: monthParam().describe('The budget month: "current" or first-of-month YYYY-MM-01'),
    from_category_id: ynabId().describe('The category UUID to take budgeted money from'),
    to_category_id: ynabId().describe('The category UUID to add budgeted money to'),
    amount: z
      .number()
      .finite()
      .positive()
      .describe('Amount to move in dollars (e.g., 50.00), greater than zero'),
  })
  .refine((v) => v.from_category_id !== v.to_category_id, {
    message: 'from_category_id and to_category_id must be different categories',
    path: ['to_category_id'],
  })
  .refine((v) => toMilliunits(v.amount) > 0, {
    message: 'amount must be at least $0.001',
    path: ['amount'],
  });

// Tool definition
export const moveMoneyTool: Tool = {
  name: 'ynab_move_money',
  description: `Move budgeted money from one category to another within a single month.

Use when the user asks:
- "Move $50 from Dining Out to Groceries"
- "Cover my overspent Groceries category from Fun Money"
- "Shift $100 of this month's budget from [category] to [category]"

This subtracts the amount from the first category's budgeted amount and adds it to the second's, for the given month. It changes budgeted amounts only: it does NOT create a YNAB money-movement record, because the YNAB API has no money-movement write, so the move will not appear in ynab_list_money_movements. The two updates are not atomic: if the second fails, the tool tries to restore the first and reports whether that rollback succeeded.

The amount is in dollars and must be greater than zero. The month is "current" or first-of-month format (e.g., 2024-01-01). Use ynab_list_categories to find category IDs. To set an absolute budgeted amount for one category use ynab_update_category.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.`,
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
        maxLength: MONTH_MAX_LENGTH,
        description: 'The budget month: "current" or first-of-month YYYY-MM-01',
      },
      from_category_id: {
        type: 'string',
        maxLength: 36,
        description: 'The category UUID to take budgeted money from',
      },
      to_category_id: {
        type: 'string',
        maxLength: 36,
        description: 'The category UUID to add budgeted money to (must differ from from_category_id)',
      },
      amount: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Amount to move in dollars (greater than zero)',
      },
    },
    required: ['month', 'from_category_id', 'to_category_id', 'amount'],
  },
};

interface CategorySnapshot {
  id: string;
  name: string;
  budgeted: number;
  balance: number;
}

function snapshot(category: {
  id: string;
  name: string;
  budgeted: number;
  balance: number;
}): CategorySnapshot {
  return {
    id: category.id,
    name: sanitizeName(category.name),
    budgeted: category.budgeted,
    balance: category.balance,
  };
}

function describeSide(before: CategorySnapshot, afterBudgeted: number, afterBalance: number) {
  return {
    id: before.id,
    name: before.name,
    budgeted_before: formatCurrency(before.budgeted),
    budgeted_after: formatCurrency(afterBudgeted),
    budgeted_after_milliunits: afterBudgeted,
    balance_after: formatCurrency(afterBalance),
  };
}

function causeOf(error: unknown): unknown {
  try {
    return JSON.parse(formatErrorResponse(error));
  } catch {
    return { error: true, message: 'Request failed' };
  }
}

function recordAudit(
  client: YnabClient,
  entry: {
    budgetId: string;
    month: string;
    from: string;
    to: string;
    amountMilliunits: number;
    success: boolean;
    outcome: string;
  }
): void {
  try {
    client.getAuditLog().log({
      operation: 'move',
      tool: 'ynab_move_money',
      budgetId: entry.budgetId,
      resourceType: 'category',
      resourceId: entry.from,
      details: {
        month: entry.month,
        to_category_id: entry.to,
        amount_milliunits: entry.amountMilliunits,
        outcome: entry.outcome,
      },
      success: entry.success,
    });
  } catch {
    // Audit failures must not mask the result of a completed write.
  }
}

// Handler function
/**
 * Handler for the ynab_move_money tool.
 */
export async function handleMoveMoney(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budget = client.resolveBudgetId(validated.budget_id);
  const month = validated.month === 'current' ? getCurrentMonth() : validated.month;
  const amount = toMilliunits(validated.amount);

  // Read both categories before changing anything so a bad id fails cleanly.
  const fromRes = await client.getMonthCategoryById(budget, month, validated.from_category_id);
  const toRes = await client.getMonthCategoryById(budget, month, validated.to_category_id);
  const from = snapshot(fromRes.data.category);
  const to = snapshot(toRes.data.category);

  const newFromBudgeted = subtractMilliunits(from.budgeted, amount);
  const newToBudgeted = addMilliunits(to.budgeted, amount);

  const audit = (success: boolean, outcome: string): void =>
    recordAudit(client, {
      budgetId: budget,
      month,
      from: from.id,
      to: to.id,
      amountMilliunits: amount,
      success,
      outcome,
    });

  // Leg 1: if this throws nothing has changed, so let the error propagate.
  let fromUpdated;
  try {
    fromUpdated = await client.updateMonthCategory(budget, month, from.id, {
      category: { budgeted: newFromBudgeted },
    });
  } catch (error) {
    audit(false, 'first_update_failed');
    throw error;
  }

  // Leg 2: on failure, put the first category back.
  let toUpdated;
  try {
    toUpdated = await client.updateMonthCategory(budget, month, to.id, {
      category: { budgeted: newToBudgeted },
    });
  } catch (error) {
    let rolledBack: boolean;
    try {
      await client.updateMonthCategory(budget, month, from.id, {
        category: { budgeted: from.budgeted },
      });
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
    audit(false, rolledBack ? 'second_update_failed_rolled_back' : 'second_update_failed_rollback_failed');
    return JSON.stringify(
      {
        error: true,
        success: false,
        type: rolledBack ? 'move_failed_rolled_back' : 'move_partially_applied',
        rolled_back: rolledBack,
        message: rolledBack
          ? `Could not add ${formatCurrency(amount)} to "${to.name}". "${from.name}" was restored to ${formatCurrency(from.budgeted)}; no budgeted amounts changed.`
          : `Could not add ${formatCurrency(amount)} to "${to.name}", and restoring "${from.name}" also failed. "${from.name}" is now budgeted at ${formatCurrency(newFromBudgeted)} (was ${formatCurrency(from.budgeted)}) and "${to.name}" is unchanged at ${formatCurrency(to.budgeted)}. Set "${from.name}" back to ${formatCurrency(from.budgeted)} with ynab_update_category.`,
        month,
        from: { id: from.id, name: from.name, original_budgeted: formatCurrency(from.budgeted), original_budgeted_milliunits: from.budgeted },
        to: { id: to.id, name: to.name, original_budgeted: formatCurrency(to.budgeted), original_budgeted_milliunits: to.budgeted },
        cause: causeOf(error),
      },
      null,
      2
    );
  }

  audit(true, 'moved');

  const fromAfter = fromUpdated.data.category;
  const toAfter = toUpdated.data.category;
  const warnings: string[] = [];
  if (fromAfter.balance < 0) {
    warnings.push(
      `"${from.name}" now has a negative balance (${formatCurrency(fromAfter.balance)}); it is overspent for this month.`
    );
  }

  return JSON.stringify(
    {
      success: true,
      message: `Moved ${formatCurrency(amount)} of budgeted money from "${from.name}" to "${to.name}" for ${month}`,
      month,
      amount: formatCurrency(amount),
      amount_milliunits: amount,
      from: describeSide(from, fromAfter.budgeted, fromAfter.balance),
      to: describeSide(to, toAfter.budgeted, toAfter.balance),
      ...(warnings.length > 0 && { warnings }),
      note: 'Budgeted amounts were changed; no YNAB money-movement record was created.',
    },
    null,
    2
  );
}
