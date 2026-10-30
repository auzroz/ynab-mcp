/**
 * Shared Zod schema helpers.
 */

import { z } from 'zod';

/**
 * YNAB entity ID (account, category, payee, transaction, ...).
 *
 * Intentionally uses z.guid() rather than strict z.uuid(): YNAB IDs are not
 * guaranteed to be RFC 9562 variant-compliant, and z.guid() keeps the
 * permissive 8-4-4-4-12 hex check the project had under zod 3.
 */
export const ynabId = (message?: string) => z.guid(message);

/**
 * Budget ID. Accepts a UUID or the "last-used" / "default" sentinels, so it
 * must NOT be strict about UUID format. Capped at 64 chars.
 */
export const budgetId = () => z.string().max(64);
