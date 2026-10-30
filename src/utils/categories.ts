/**
 * Helpers for recognising YNAB's internal (system) categories and groups.
 *
 * API 1.84 added an `internal` flag to category groups and categories. Older
 * responses and test fixtures lack it, so the flag is preferred when present
 * and the historical name check is the fallback when it is undefined.
 */

export const INTERNAL_GROUP_NAME = 'Internal Master Category';

interface InternalFlagged {
  internal?: boolean | null;
}

/** True when a category group is YNAB-internal (e.g. holds "Inflow: Ready to Assign"). */
export function isInternalGroup(group: InternalFlagged & { name?: string | null }): boolean {
  return group.internal ?? group.name === INTERNAL_GROUP_NAME;
}

/**
 * True when a category is YNAB-internal: its own flag is set, or its group is
 * internal. The checks are combined with OR so a category in an internal group
 * is never counted, even if the API leaves the category flag false.
 */
export function isInternalCategory(
  category: InternalFlagged,
  group?: InternalFlagged & { name?: string | null }
): boolean {
  return category.internal === true || (group ? isInternalGroup(group) : false);
}

interface IndexableGroup extends InternalFlagged {
  name: string;
  categories: Array<InternalFlagged & { id: string }>;
}

/**
 * Index category groups by category id: the owning group's name, and the set
 * of category ids that are internal. Used by tools that receive categories
 * from month data (which carry no group) and need to look the group up.
 */
export function indexCategoryGroups(groups: IndexableGroup[]): {
  names: Map<string, string>;
  internalIds: Set<string>;
} {
  const names = new Map<string, string>();
  const internalIds = new Set<string>();
  for (const group of groups) {
    for (const cat of group.categories) {
      names.set(cat.id, group.name);
      if (isInternalCategory(cat, group)) internalIds.add(cat.id);
    }
  }
  return { names, internalIds };
}
