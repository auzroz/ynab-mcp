/**
 * The optional delta cursor of the list tools (since_server_knowledge).
 *
 * Every list tool response carries server_knowledge. Passing it back as
 * since_server_knowledge (same budget and filters) returns only what changed
 * since then, straight from YNAB's delta response: changed entities in the
 * usual list fields, deleted ones by id, and `delta: true`. Without it the tool
 * returns its full result as before.
 */

import { z } from 'zod';

const DESCRIPTION =
  'Delta cursor: the server_knowledge from an earlier response of this tool for the same budget (and filters). When given, only entities changed since then are returned (delta: true), with deleted ones listed by id in deleted_ids; omit it for the full list';

/** Zod input for the cursor: a non-negative integer. */
export function sinceServerKnowledge() {
  return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe(DESCRIPTION);
}

/** Hand-written JSON Schema for the cursor (kept in sync with sinceServerKnowledge). */
export const sinceServerKnowledgeJsonSchema = {
  type: 'integer',
  minimum: 0,
  description: DESCRIPTION,
} as const;

/** Summary note for delta responses, which list changes only. */
export const DELTA_SUMMARY_NOTE =
  'Delta response: only entities changed since since_server_knowledge are listed (visibility filters such as include_closed/include_hidden do not apply), so counts cover changes only and no totals are given. Pass server_knowledge as since_server_knowledge next time.';

/** The fields that mark a delta response. */
export function deltaFields(since: number, deletedIds: string[]) {
  return { delta: true, since_server_knowledge: since, deleted_ids: deletedIds };
}

/** Split a delta list into the entities still present and the ids of deleted ones. */
export function splitDeleted<T extends { deleted?: boolean | undefined }>(
  entities: readonly T[],
  id: (entity: T) => string
): { changed: T[]; deletedIds: string[] } {
  const changed: T[] = [];
  const deletedIds: string[] = [];
  for (const entity of entities) {
    if (entity.deleted === true) deletedIds.push(id(entity));
    else changed.push(entity);
  }
  return { changed, deletedIds };
}

/**
 * Caveat for transaction deltas: YNAB filters a delta by the query's current
 * values, so a transaction that changed out of the query need not be listed.
 */
export const TRANSACTION_DELTA_FILTER_NOTE =
  'A transaction that changed so it no longer matches this query (approved, re-categorized, re-dated, moved to another account or payee, or older than the default 12-month window) may be left out of this delta and is not in deleted_ids. To keep a filtered list exact, re-read it in full (omit since_server_knowledge) from time to time.';

/** Why a truncated transaction delta keeps the caller's cursor. */
export const TRUNCATED_DELTA_NOTE =
  'More transactions changed than limit allows, so server_knowledge is your since_server_knowledge unchanged and no change is skipped. Raise limit (max 500), narrow the filters, or re-read in full without since_server_knowledge.';

/**
 * The delta-specific summary fields and server_knowledge of a transaction list
 * tool. A delta cut short by `limit` hands back the caller's own cursor
 * (cursor_withheld: true): the response's server_knowledge would move the
 * caller past the changes it left out.
 */
export function transactionDeltaResult(
  cursor: number | undefined,
  serverKnowledge: number | undefined,
  truncated: boolean
): { summary: Record<string, unknown>; cursor: Record<string, unknown> } {
  if (cursor === undefined) return { summary: {}, cursor: { server_knowledge: serverKnowledge } };
  return {
    summary: {
      note: DELTA_SUMMARY_NOTE,
      filter_note: TRANSACTION_DELTA_FILTER_NOTE,
      ...(truncated ? { truncation_note: TRUNCATED_DELTA_NOTE } : {}),
    },
    cursor: truncated ? { server_knowledge: cursor, cursor_withheld: true } : { server_knowledge: serverKnowledge },
  };
}
