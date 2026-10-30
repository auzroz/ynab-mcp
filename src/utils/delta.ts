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
