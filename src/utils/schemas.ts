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
export const BUDGET_ID_MAX_LENGTH = 64;
export const budgetId = () => z.string().max(BUDGET_ID_MAX_LENGTH);

/*
 * Free-text length caps. Every free-text string input is capped in both the zod
 * schema and the hand-written JSON inputSchema (maxLength); keep the two in sync.
 * Limits marked "YNAB" come from the YNAB OpenAPI spec. Where YNAB states no
 * limit (account/category names, category notes, filters, natural-language
 * dates) these are sane caps of our own: 200 for names, 500 for notes.
 */
/** YNAB: transaction / scheduled transaction memo. */
export const MEMO_MAX_LENGTH = 500;
/** YNAB: transaction payee_name. */
export const TXN_PAYEE_NAME_MAX_LENGTH = 200;
/** YNAB: payee name when creating or renaming a payee. */
export const PAYEE_NAME_MAX_LENGTH = 500;
/** YNAB: transaction import_id. */
export const IMPORT_ID_MAX_LENGTH = 36;
/** YNAB: category group name. */
export const CATEGORY_GROUP_NAME_MAX_LENGTH = 50;
/** Our cap (YNAB states none): account and category names, name filters. */
export const NAME_MAX_LENGTH = 200;
/** Our cap (YNAB states none): category notes and free-text search queries. */
export const NOTE_MAX_LENGTH = 500;
/** Our cap: since/until dates, which also accept natural language ("past 30 days"). */
export const DATE_TEXT_MAX_LENGTH = 100;
