/**
 * Shared category target (goal) fragments
 *
 * Zod shapes and matching hand-written JSON-schema properties for the writable
 * target fields on create/update category requests. Used by ynab_create_category
 * and (WS5.5) ynab_update_category_details.
 *
 * Writable per the installed ynab SDK (NewCategory / SaveCategory):
 *   goal_target, goal_target_date, goal_needs_whole_amount.
 * goal_frequency (YNAB API 1.88) is also writable but the SDK drops it on
 * serialization, so YnabClient sends requests that carry it directly.
 * goal_target_month is deprecated and not written.
 *
 * Create requests accept values only; update requests additionally accept
 * null to remove an existing target.
 */

import { z } from "zod";
import { toMilliunits } from "../../utils/milliunits.js";

const GOAL_TARGET_DESCRIPTION =
  "Target amount in dollars (e.g. 200 for $200.00; >= 0). Creates a monthly goal if none exists";
const GOAL_TARGET_DATE_DESCRIPTION =
  "Target date in YYYY-MM-DD format. Not supported for categories paired to a loan account";
const GOAL_NEEDS_WHOLE_AMOUNT_DESCRIPTION =
  'Only for spending-target (NEED) goals. true = "Set aside another..." each period, false = "Refill up to..."';
const GOAL_FREQUENCY_DESCRIPTION =
  'Makes goal_target a recurring "set aside" (NEED) target that repeats at this frequency, e.g. goal_target 50 with "weekly" = $50 every week. Replaces any existing target. Requires goal_target; cannot be combined with goal_target_date; not supported for Credit Card Payment categories or categories paired to a loan account';
export const GOAL_FREQUENCIES = ['monthly', 'weekly', 'yearly'] as const;
export type GoalFrequency = (typeof GOAL_FREQUENCIES)[number];
const CLEAR_SUFFIX = " Pass null to remove the existing value.";

// Largest dollar amount whose milliunit value is still a safe integer. Larger
// inputs would lose precision or overflow to Infinity, which JSON sends as null
// and the update endpoint treats as "remove the target".
export const GOAL_TARGET_MAX_DOLLARS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

/** Zod fields for create requests (values only). */
export const categoryTargetCreateShape = {
  goal_target: z
    .number()
    .finite()
    .min(0)
    .max(GOAL_TARGET_MAX_DOLLARS)
    .describe(GOAL_TARGET_DESCRIPTION)
    .optional(),
  goal_target_date: z.iso
    .date()
    .describe(GOAL_TARGET_DATE_DESCRIPTION)
    .optional(),
  goal_needs_whole_amount: z
    .boolean()
    .describe(GOAL_NEEDS_WHOLE_AMOUNT_DESCRIPTION)
    .optional(),
  goal_frequency: z.enum(GOAL_FREQUENCIES).describe(GOAL_FREQUENCY_DESCRIPTION).optional(),
};

/** Zod fields for update requests (values or null to clear). */
export const categoryTargetUpdateShape = {
  goal_target: z
    .number()
    .finite()
    .min(0)
    .max(GOAL_TARGET_MAX_DOLLARS)
    .nullable()
    .describe(GOAL_TARGET_DESCRIPTION + CLEAR_SUFFIX)
    .optional(),
  goal_target_date: z.iso
    .date()
    .nullable()
    .describe(GOAL_TARGET_DATE_DESCRIPTION + CLEAR_SUFFIX)
    .optional(),
  goal_needs_whole_amount: z
    .boolean()
    .nullable()
    .describe(GOAL_NEEDS_WHOLE_AMOUNT_DESCRIPTION + CLEAR_SUFFIX)
    .optional(),
  goal_frequency: z.enum(GOAL_FREQUENCIES).describe(GOAL_FREQUENCY_DESCRIPTION).optional(),
};

/** JSON-schema properties matching categoryTargetCreateShape. */
export const categoryTargetCreateJsonProperties = {
  goal_target: {
    type: "number",
    minimum: 0,
    maximum: GOAL_TARGET_MAX_DOLLARS,
    description: GOAL_TARGET_DESCRIPTION,
  },
  goal_target_date: {
    type: "string",
    format: "date",
    maxLength: 10,
    description: GOAL_TARGET_DATE_DESCRIPTION,
  },
  goal_needs_whole_amount: {
    type: "boolean",
    description: GOAL_NEEDS_WHOLE_AMOUNT_DESCRIPTION,
  },
  goal_frequency: {
    type: "string",
    enum: GOAL_FREQUENCIES,
    description: GOAL_FREQUENCY_DESCRIPTION,
  },
} as const;

/** JSON-schema properties matching categoryTargetUpdateShape. */
export const categoryTargetUpdateJsonProperties = {
  goal_target: {
    type: ["number", "null"],
    minimum: 0,
    maximum: GOAL_TARGET_MAX_DOLLARS,
    description: GOAL_TARGET_DESCRIPTION + CLEAR_SUFFIX,
  },
  goal_target_date: {
    type: ["string", "null"],
    format: "date",
    maxLength: 10,
    description: GOAL_TARGET_DATE_DESCRIPTION + CLEAR_SUFFIX,
  },
  goal_needs_whole_amount: {
    type: ["boolean", "null"],
    description: GOAL_NEEDS_WHOLE_AMOUNT_DESCRIPTION + CLEAR_SUFFIX,
  },
  goal_frequency: {
    type: "string",
    enum: GOAL_FREQUENCIES,
    description: GOAL_FREQUENCY_DESCRIPTION,
  },
} as const;

export const CATEGORY_TARGET_FIELDS = [
  "goal_target",
  "goal_target_date",
  "goal_needs_whole_amount",
  "goal_frequency",
] as const;

export type CategoryTargetField = (typeof CATEGORY_TARGET_FIELDS)[number];

/**
 * Refine for target inputs: goal_frequency needs a numeric goal_target in the
 * same request and cannot be combined with goal_target_date. Spread the checks
 * onto a z.object via .superRefine(refineGoalFrequency).
 */
export function refineGoalFrequency(
  v: { goal_frequency?: unknown; goal_target?: number | null | undefined; goal_target_date?: string | null | undefined },
  ctx: z.RefinementCtx
): void {
  if (v.goal_frequency === undefined) return;
  if (typeof v.goal_target !== "number") {
    ctx.addIssue({
      code: "custom",
      path: ["goal_frequency"],
      message: "goal_frequency requires goal_target (a number) in the same request",
    });
  }
  if (v.goal_target_date !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["goal_frequency"],
      message: "goal_frequency cannot be combined with goal_target_date",
    });
  }
}

/**
 * Pick the target fields that were provided (undefined omitted, null kept).
 * goal_target is accepted in dollars and converted to milliunits here.
 * The return type drops `undefined` from each property so it satisfies the
 * SDK models under exactOptionalPropertyTypes.
 */
export function pickCategoryTargets<
  T extends Partial<Record<CategoryTargetField, unknown>>,
>(input: T): { [K in CategoryTargetField]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of CATEGORY_TARGET_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    out[key] =
      key === "goal_target" && typeof value === "number"
        ? toMilliunits(value)
        : value;
  }
  return out as { [K in CategoryTargetField]?: Exclude<T[K], undefined> };
}
