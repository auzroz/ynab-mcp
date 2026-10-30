/**
 * Shared split-transaction (subtransaction) helpers for the create tools.
 *
 * YNAB can create a split transaction in one request but cannot edit the splits
 * of an existing transaction, nor create scheduled transactions with splits.
 */

import { z } from 'zod';
import type * as ynab from 'ynab';
import { MEMO_MAX_LENGTH, TXN_PAYEE_NAME_MAX_LENGTH, ynabId } from '../../utils/schemas.js';
import { formatCurrency, sumMilliunits, toMilliunits } from '../../utils/milliunits.js';
import { sanitizeMemo, sanitizeName } from '../../utils/sanitize.js';

/** Minimum splits for a split transaction (YNAB: a split needs at least two parts). */
export const MIN_SUBTRANSACTIONS = 2;
/** Our cap on splits per transaction (YNAB states none). */
export const MAX_SUBTRANSACTIONS = 100;

export const subtransactionSchema = z
  .object({
    amount: z.number().describe('Split amount in dollars (same sign convention as the parent)'),
    payee_id: ynabId().optional().describe('Payee UUID for this split'),
    payee_name: z.string().max(TXN_PAYEE_NAME_MAX_LENGTH).optional().describe('Payee name for this split'),
    category_id: ynabId().optional().describe('Category UUID for this split'),
    memo: z.string().max(MEMO_MAX_LENGTH).optional().describe('Memo for this split'),
  })
  .refine((s) => !(s.payee_id !== undefined && s.payee_name !== undefined), {
    message: 'Provide either payee_id or payee_name on a split, not both',
  });

export const subtransactionsSchema = z
  .array(subtransactionSchema)
  .min(MIN_SUBTRANSACTIONS)
  .max(MAX_SUBTRANSACTIONS)
  .describe(
    'Split the transaction across categories (at least 2). Split amounts must sum exactly to the parent amount, and the parent must not set category_id.'
  );

/** Hand-written JSON Schema for the subtransactions property (kept in sync with the zod schema). */
export const subtransactionsJsonSchema = {
  type: 'array',
  minItems: MIN_SUBTRANSACTIONS,
  maxItems: MAX_SUBTRANSACTIONS,
  description:
    'Split the transaction across categories (at least 2). Split amounts (dollars) must sum exactly to the parent amount, and the parent must not set category_id. Each split takes amount, optional payee_id or payee_name, category_id and memo.',
  items: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'Split amount in dollars' },
      payee_id: { type: 'string', maxLength: 36, description: 'Payee UUID for this split' },
      payee_name: { type: 'string', maxLength: TXN_PAYEE_NAME_MAX_LENGTH, description: 'Payee name for this split' },
      category_id: { type: 'string', maxLength: 36, description: 'Category UUID for this split' },
      memo: { type: 'string', maxLength: MEMO_MAX_LENGTH, description: 'Memo for this split' },
    },
    required: ['amount'],
  },
} as const;

/**
 * Cross-field rules for a transaction that may carry splits. Intended for a
 * zod `.superRefine` on the transaction object.
 */
export function checkSplitRules(
  txn: {
    amount: number;
    category_id?: string | undefined;
    subtransactions?: Array<{ amount: number }> | undefined;
  },
  ctx: z.RefinementCtx
): void {
  if (txn.subtransactions === undefined) return;

  if (txn.category_id !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['category_id'],
      message: 'A split transaction cannot also set category_id; set the category on each split instead',
    });
  }

  const splitTotal = sumMilliunits(txn.subtransactions.map((s) => toMilliunits(s.amount)));
  const parent = toMilliunits(txn.amount);
  if (splitTotal !== parent) {
    ctx.addIssue({
      code: 'custom',
      path: ['subtransactions'],
      message: `Split amounts must sum exactly to the transaction amount (splits total ${formatCurrency(splitTotal)}, transaction is ${formatCurrency(parent)})`,
    });
  }
}

/** Convert validated splits to the YNAB request shape (dollars to milliunits). */
export function toSaveSubTransactions(
  subtransactions: z.infer<typeof subtransactionsSchema>
): ynab.SaveSubTransaction[] {
  return subtransactions.map((s) => {
    const split: ynab.SaveSubTransaction = { amount: toMilliunits(s.amount) };
    if (s.payee_id !== undefined) split.payee_id = s.payee_id;
    if (s.payee_name !== undefined) split.payee_name = s.payee_name;
    if (s.category_id !== undefined) split.category_id = s.category_id;
    if (s.memo !== undefined) split.memo = s.memo;
    return split;
  });
}

/** Sanitized view of the splits YNAB returned, or undefined when there are none. */
export function formatSubtransactions(
  subtransactions: ynab.SubTransaction[] | undefined
): Array<Record<string, unknown>> | undefined {
  const live = (subtransactions ?? []).filter((s) => !s.deleted);
  if (live.length === 0) return undefined;
  return live.map((s) => ({
    id: s.id,
    amount: formatCurrency(s.amount),
    amount_milliunits: s.amount,
    payee_id: s.payee_id ?? null,
    payee_name: sanitizeName(s.payee_name),
    category_id: s.category_id ?? null,
    category_name: sanitizeName(s.category_name),
    memo: sanitizeMemo(s.memo),
  }));
}
