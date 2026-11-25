/**
 * Move Money Tool
 *
 * Convenience write tool: shifts budgeted money from one category to another
 * in a single month by adjusting both categories' budgeted amounts.
 *
 * The YNAB API has no money-movement write endpoint, so this does NOT create a
 * money-movement record (those only appear when YNAB's own apps move money).
 * It performs two budgeted-amount updates and, if the second one fails, tries
 * to restore the first (only when the first category still holds the value this
 * tool wrote).
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { addMilliunits, moneyFormatterFor, subtractMilliunits, toMilliunits, type MoneyFormatter } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { budgetId, monthParam, ynabId, MONTH_MAX_LENGTH } from '../../utils/schemas.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { errorResponseSchema, formatErrorResponse, ReadOnlyModeError, ValidationError, YnabAuthError } from '../../utils/errors.js';
import { isInternalCategory } from '../../utils/categories.js';
import { toOutputSchema } from '../output-schema.js';
import { fromYnab, milliunits, money } from '../schemas/common.js';

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
  .refine((v) => v.from_category_id.toLowerCase() !== v.to_category_id.toLowerCase(), {
    message: 'from_category_id and to_category_id must be different categories',
    path: ['to_category_id'],
  })
  .refine((v) => toMilliunits(v.amount) > 0, {
    message: 'amount must be at least 0.001 (1 milliunit)',
    path: ['amount'],
  });

const FAILED = 'In-band failure results only';
const DONE = 'Successful move only';

/** One category of the move: its state before (failures) or before and after (success). */
const sideSchema = z.object({
  id: fromYnab(z.string()),
  name: z.string(),
  original_budgeted: money().exactOptional().describe(FAILED),
  original_budgeted_milliunits: milliunits().exactOptional().describe(FAILED),
  budgeted_before: money().exactOptional().describe(DONE),
  budgeted_after: money().exactOptional().describe(DONE),
  budgeted_after_milliunits: milliunits().exactOptional().describe(DONE),
  balance_after: money().exactOptional().describe(DONE),
});

/** The error a failed category update reported (formatErrorResponse's object). */
const causeSchema = errorResponseSchema.partial({ type: true, suggestion: true });
type Cause = z.output<typeof causeSchema>;

/**
 * What the tool returns (#45; rules in ../output-schema.ts). One object covers
 * the successful move and the four in-band failures (`error: true,
 * success: false`), which are ordinary results, not tool errors.
 */
export const moveMoneyOutputSchema = z.object({
  error: z.literal(true).exactOptional().describe(FAILED),
  success: z.boolean(),
  type: z
    .enum(['move_outcome_uncertain', 'move_partially_applied', 'move_failed_rolled_back'])
    .exactOptional()
    .describe(FAILED),
  rolled_back: z.boolean().exactOptional().describe(FAILED),
  message: z.string(),
  month: z.string(),
  amount: money().exactOptional().describe(DONE),
  amount_milliunits: milliunits().exactOptional().describe(DONE),
  from: sideSchema,
  to: sideSchema,
  from_intended_budgeted: money().exactOptional().describe('When the first update could not be confirmed'),
  from_intended_budgeted_milliunits: milliunits().exactOptional().describe('When the first update could not be confirmed'),
  to_intended_budgeted: money().exactOptional().describe('When the first update could not be confirmed'),
  to_intended_budgeted_milliunits: milliunits().exactOptional().describe('When the first update could not be confirmed'),
  cause: causeSchema.exactOptional().describe(`${FAILED}: the error the failed update reported`),
  warnings: z.array(z.string()).exactOptional().describe(`${DONE}, when there is something to flag`),
  note: z.string().exactOptional().describe(DONE),
});
export type MoveMoneyOutput = z.output<typeof moveMoneyOutputSchema>;

// Tool definition
export const moveMoneyTool: Tool = {
  name: 'ynab_move_money',
  description: `Move budgeted money from one category to another within a single month.

Use when the user asks:
- "Move $50 from Dining Out to Groceries"
- "Cover my overspent Groceries category from Fun Money"
- "Shift $100 of this month's budget from [category] to [category]"

This subtracts the amount from the first category's budgeted amount and adds it to the second's, for the given month. It changes budgeted amounts only: it does NOT create a YNAB money-movement record, because the YNAB API has no money-movement write, so the move will not appear in ynab_list_money_movements. The two updates are not atomic: if the second fails, the tool tries to restore the first and reports whether that rollback succeeded. A failed move may need a manual check: if a request errors with an unknown outcome, or the source category was edited by someone else in the meantime, the tool does not guess and reports move_outcome_uncertain or move_partially_applied, and the categories should be verified with ynab_get_month_category.

The amount is in dollars and must be greater than zero. The month is "current" or first-of-month format (e.g., 2024-01-01). Use ynab_list_categories to find category IDs. To set an absolute budgeted amount for one category use ynab_update_category.

Internal categories (such as "Inflow: Ready to Assign") cannot be used as the source or target. To assign money from Ready to Assign to a category, set that category's budgeted amount with ynab_update_category.

**Note:** This is a write operation. Requires YNAB_READ_ONLY=false.

${UNTRUSTED_TEXT_NOTE}`,
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
  outputSchema: toOutputSchema(moveMoneyOutputSchema),
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

function describeSide(
  before: CategorySnapshot,
  afterBudgeted: number,
  afterBalance: number,
  money: MoneyFormatter
) {
  return {
    id: before.id,
    name: before.name,
    budgeted_before: money(before.budgeted),
    budgeted_after: money(afterBudgeted),
    budgeted_after_milliunits: afterBudgeted,
    balance_after: money(afterBalance),
  };
}

function causeOf(error: unknown): Cause {
  try {
    return JSON.parse(formatErrorResponse(error)) as Cause;
  } catch {
    return { error: true, message: 'Request failed' };
  }
}

/**
 * The move as one audit row (#60a), besides the two category updates the
 * client records: which category, and whether the move as a whole went
 * through. The detailed outcome (rolled back, outcome unknown) is in the
 * tool's result; the row holds no amount.
 */
async function recordAudit(client: YnabClient, budgetId: string, fromId: string, success: boolean): Promise<void> {
  // Never throws: an audit failure must not mask the result of a completed write.
  await client.getAuditLog().record({
    operation: 'move',
    tool: 'ynab_move_money',
    budgetId,
    resourceType: 'category',
    resourceId: fromId,
    outcome: success ? 'success' : 'error',
  });
}

// Handler function
/**
 * Handler for the ynab_move_money tool.
 */
export async function handleMoveMoney(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<MoveMoneyOutput> {
  const validated = inputSchema.parse(args);
  const budget = await client.resolveBudgetId(validated.budget_id, { fresh: true });
  // Fail fast in read-only sessions: no category reads and no settings request for a refused write.
  if (client.isReadOnly()) {
    throw new ReadOnlyModeError('updateMonthCategory');
  }
  const month = validated.month === 'current' ? getCurrentMonth() : validated.month;
  const amount = toMilliunits(validated.amount);

  // Read both categories before changing anything so a bad id fails cleanly.
  const fromRes = await client.getMonthCategoryById(budget, month, validated.from_category_id);
  const toRes = await client.getMonthCategoryById(budget, month, validated.to_category_id);
  const fromCat = fromRes.data.category;
  const toCat = toRes.data.category;

  // The two ids can still differ in case while naming one category; the
  // absolute writes below would then not cancel out.
  if (fromCat.id.toLowerCase() === toCat.id.toLowerCase()) {
    throw new ValidationError('from_category_id and to_category_id must be different categories');
  }
  for (const cat of [fromCat, toCat]) {
    if (isInternalCategory(cat, { name: cat.category_group_name ?? null })) {
      throw new ValidationError(
        'Internal categories such as "Inflow: Ready to Assign" cannot be used with ynab_move_money. To assign money from Ready to Assign, set the category\'s budgeted amount with ynab_update_category.'
      );
    }
  }

  const from = snapshot(fromCat);
  const to = snapshot(toCat);

  const newFromBudgeted = subtractMilliunits(from.budgeted, amount);
  const newToBudgeted = addMilliunits(to.budgeted, amount);

  // The detailed outcome names (first_update_failed, rolled back, ...) say why;
  // the row records only whether the move went through.
  const audit = (success: boolean, _outcome: string): Promise<void> => recordAudit(client, budget, from.id, success);

  const money = await moneyFormatterFor(client, budget);
  const sides = {
    from: { id: from.id, name: from.name, original_budgeted: money(from.budgeted), original_budgeted_milliunits: from.budgeted },
    to: { id: to.id, name: to.name, original_budgeted: money(to.budgeted), original_budgeted_milliunits: to.budgeted },
  };

  // Leg 1: a thrown error does not prove nothing changed (a timeout or 5xx can
  // arrive after YNAB applied the write), so verify by re-reading "from".
  let fromUpdated: { data: { category: { budgeted: number; balance: number } } };
  let fromAppliedDespiteError = false;
  try {
    fromUpdated = await client.updateMonthCategory(budget, month, from.id, {
      category: { budgeted: newFromBudgeted },
    });
  } catch (error) {
    // Read-only, validation and access-token resolution failures happen before
    // any request is sent, so nothing can have been written.
    if (
      error instanceof ReadOnlyModeError ||
      error instanceof ValidationError ||
      error instanceof YnabAuthError
    ) {
      await audit(false, 'first_update_failed');
      throw error;
    }

    let observedFrom: number | undefined;
    let rereadFrom: { budgeted: number; balance: number } | undefined;
    try {
      const reread = await client.getMonthCategoryById(budget, month, from.id);
      observedFrom = reread.data.category.budgeted;
      rereadFrom = reread.data.category;
    } catch {
      observedFrom = undefined;
    }

    if (observedFrom === from.budgeted) {
      // Confirmed unchanged: nothing was written.
      await audit(false, 'first_update_failed');
      throw error;
    }

    if (observedFrom !== undefined && rereadFrom && observedFrom === newFromBudgeted) {
      fromAppliedDespiteError = true;
      fromUpdated = { data: { category: rereadFrom } };
    } else {
      // Re-read failed or shows an unexpected value: do not attempt leg 2.
      await audit(false, 'first_update_outcome_unknown');
      return {
        error: true,
        success: false,
        type: 'move_outcome_uncertain',
        rolled_back: false,
        message: `Could not confirm whether "${from.name}" was reduced by ${money(amount)}. It was ${money(from.budgeted)} before and may be ${money(newFromBudgeted)}, unchanged, or something else if it was edited meanwhile; "${to.name}" was ${money(to.budgeted)} and would become ${money(newToBudgeted)}. No further writes were attempted. Check both categories with ynab_get_month_category and correct them with ynab_update_category.`,
        month,
        ...sides,
        from_intended_budgeted: money(newFromBudgeted),
        from_intended_budgeted_milliunits: newFromBudgeted,
        to_intended_budgeted: money(newToBudgeted),
        to_intended_budgeted_milliunits: newToBudgeted,
        cause: causeOf(error),
      };
    }
  }

  // Leg 2: on failure, work out whether the write actually landed before
  // deciding whether to restore the first category.
  let toUpdated: { data: { category: { budgeted: number; balance: number } } } | undefined;
  let appliedDespiteError = false;
  try {
    toUpdated = await client.updateMonthCategory(budget, month, to.id, {
      category: { budgeted: newToBudgeted },
    });
  } catch (error) {
    // A timeout or 5xx can arrive after YNAB applied the write. Re-read to find out.
    let observed: number | undefined;
    try {
      const reread = await client.getMonthCategoryById(budget, month, to.id);
      observed = reread.data.category.budgeted;
      if (observed === newToBudgeted) {
        appliedDespiteError = true;
        toUpdated = { data: { category: reread.data.category } };
      }
    } catch {
      observed = undefined;
    }

    if (!appliedDespiteError) {
      if (observed !== to.budgeted) {
        // Could not confirm the state of "to" (re-read failed or value is unexpected).
        // Restoring "from" could create money if the write landed, so leave both alone.
        await audit(false, 'second_update_outcome_unknown');
        return {
          error: true,
          success: false,
          type: 'move_outcome_uncertain',
          rolled_back: false,
          message: `Could not confirm whether ${money(amount)} was added to "${to.name}". "${from.name}" is now budgeted at ${money(newFromBudgeted)} (was ${money(from.budgeted)}); "${to.name}" was ${money(to.budgeted)} before and may be ${money(newToBudgeted)} or unchanged. No rollback was attempted. Check both categories with ynab_get_month_category and correct them with ynab_update_category.`,
          month,
          ...sides,
          cause: causeOf(error),
        };
      }

      // Confirmed unchanged: put the first category back, but only if nobody
      // else has edited it since we wrote newFromBudgeted. The restore is an
      // absolute write and the API has no compare-and-swap, so a tiny window
      // remains between this re-read and the restore.
      let fromNow: number | undefined;
      try {
        fromNow = (await client.getMonthCategoryById(budget, month, from.id)).data.category.budgeted;
      } catch {
        fromNow = undefined;
      }

      if (fromNow !== newFromBudgeted) {
        await audit(false, 'second_update_failed_rollback_skipped');
        return {
          error: true,
          success: false,
          type: 'move_partially_applied',
          rolled_back: false,
          message:
            fromNow === undefined
              ? `Could not add ${money(amount)} to "${to.name}", and "${from.name}" could not be re-read, so it was not restored. "${from.name}" was set to ${money(newFromBudgeted)} (was ${money(from.budgeted)}) and "${to.name}" is unchanged at ${money(to.budgeted)}. Check "${from.name}" with ynab_get_month_category and fix it with ynab_update_category.`
              : `Could not add ${money(amount)} to "${to.name}". "${from.name}" changed since the move (now ${money(fromNow)}, expected ${money(newFromBudgeted)}), so it was not restored to avoid overwriting that edit. It was ${money(from.budgeted)} before the move and "${to.name}" is unchanged at ${money(to.budgeted)}. Check "${from.name}" with ynab_get_month_category and fix it with ynab_update_category if needed.`,
          month,
          ...sides,
          cause: causeOf(error),
        };
      }

      let rolledBack: boolean;
      try {
        await client.updateMonthCategory(budget, month, from.id, {
          category: { budgeted: from.budgeted },
        });
        rolledBack = true;
      } catch {
        // A timeout or 5xx can arrive after YNAB applied the restore, so a failed
        // restore does not prove "from" is still at the reduced value.
        rolledBack = false;
      }
      await audit(
        false,
        rolledBack ? 'second_update_failed_rolled_back' : 'second_update_failed_rollback_outcome_unknown'
      );
      return {
        error: true,
        success: false,
        type: rolledBack ? 'move_failed_rolled_back' : 'move_partially_applied',
        rolled_back: rolledBack,
        message: rolledBack
          ? `Could not add ${money(amount)} to "${to.name}". "${from.name}" was restored to ${money(from.budgeted)}; no budgeted amounts changed.`
          : `Could not add ${money(amount)} to "${to.name}", and restoring "${from.name}" also failed. "${from.name}" may still be budgeted at ${money(newFromBudgeted)} (was ${money(from.budgeted)}; the restore may have been applied despite the error) and "${to.name}" is unchanged at ${money(to.budgeted)}. Check "${from.name}" with ynab_get_month_category and, if it is not ${money(from.budgeted)}, set it back with ynab_update_category.`,
        month,
        ...sides,
        cause: causeOf(error),
      };
    }
  }

  await audit(true, appliedDespiteError || fromAppliedDespiteError ? 'moved_confirmed_after_error' : 'moved');

  const fromAfter = fromUpdated.data.category;
  if (!toUpdated) {
    throw new Error('Unreachable: second update neither applied nor reported');
  }
  const toAfter = toUpdated.data.category;
  const warnings: string[] = [];
  if (fromAppliedDespiteError) {
    warnings.push(
      `The update to "${from.name}" reported an error but was confirmed applied on re-read, so the move continued.`
    );
  }
  if (appliedDespiteError) {
    warnings.push(
      `The update to "${to.name}" reported an error but was confirmed applied on re-read, so the move completed.`
    );
  }
  if (fromAfter.balance < 0) {
    warnings.push(
      `"${from.name}" now has a negative balance (${money(fromAfter.balance)}); it is overspent for this month.`
    );
  }

  return {
    success: true,
    message: `Moved ${money(amount)} of budgeted money from "${from.name}" to "${to.name}" for ${month}`,
    month,
    amount: money(amount),
    amount_milliunits: amount,
    from: describeSide(from, fromAfter.budgeted, fromAfter.balance, money),
    to: describeSide(to, toAfter.budgeted, toAfter.balance, money),
    ...(warnings.length > 0 && { warnings }),
    note: 'Budgeted amounts were changed; no YNAB money-movement record was created.',
  };
}
