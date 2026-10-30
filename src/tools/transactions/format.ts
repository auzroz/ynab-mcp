/**
 * Shared helpers for the transaction read tools: the type filter schema and the
 * output fields that let a caller chain into other tools (ids).
 */

import { z } from 'zod';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeMemo, sanitizeName, sanitizeString } from '../../utils/sanitize.js';

/** YNAB's transaction type filter, shared by every transaction list tool. */
export const transactionTypeSchema = z
  .enum(['uncategorized', 'unapproved'])
  .describe('Filter by transaction type: "uncategorized" or "unapproved"');

/** Hand-written JSON Schema for the type filter (kept in sync with transactionTypeSchema). */
export const transactionTypeJsonSchema = {
  type: 'string',
  enum: ['uncategorized', 'unapproved'],
  description: 'Filter by transaction type: "uncategorized" or "unapproved"',
} as const;

/** Max length of a returned flag label (YNAB flag names are short). */
const FLAG_NAME_MAX_LENGTH = 100;

/** The user's custom label for a flag colour, sanitized; null when unset. */
export function sanitizeFlagName(flagName: string | null | undefined): string | null {
  const cleaned = sanitizeString(flagName, FLAG_NAME_MAX_LENGTH);
  return cleaned ? cleaned : null;
}

/** Fields shared by TransactionDetail and HybridTransaction that this module reads. */
interface TransactionLike {
  account_id: string;
  payee_id?: string | null;
  category_id?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  matched_transaction_id?: string | null;
  import_id?: string | null;
  debt_transaction_type?: string | null;
  flag_name?: string | null;
}

/**
 * Ids and import/debt metadata needed to chain into other tools, plus the flag
 * label. Missing values come back as null so the keys are always present.
 */
export function transactionChainFields(txn: TransactionLike) {
  return {
    account_id: txn.account_id,
    payee_id: txn.payee_id ?? null,
    category_id: txn.category_id ?? null,
    transfer_account_id: txn.transfer_account_id ?? null,
    transfer_transaction_id: txn.transfer_transaction_id ?? null,
    matched_transaction_id: txn.matched_transaction_id ?? null,
    import_id: txn.import_id ?? null,
    debt_transaction_type: txn.debt_transaction_type ?? null,
    flag_name: sanitizeFlagName(txn.flag_name),
  };
}

interface SubtransactionLike {
  id: string;
  transaction_id: string;
  amount: number;
  memo?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
}

/** A split line with its ids, for transaction list/get output. */
export function formatSubtransaction(sub: SubtransactionLike) {
  return {
    id: sub.id,
    transaction_id: sub.transaction_id,
    amount: formatCurrency(sub.amount),
    memo: sanitizeMemo(sub.memo),
    payee_id: sub.payee_id ?? null,
    payee_name: sanitizeName(sub.payee_name),
    category_id: sub.category_id ?? null,
    category_name: sanitizeName(sub.category_name),
    transfer_account_id: sub.transfer_account_id ?? null,
    transfer_transaction_id: sub.transfer_transaction_id ?? null,
  };
}

/**
 * Truncation info for a list sliced to a limit: total_count is the number of
 * matches before the limit, truncated is true when some were left out.
 */
export function truncationSummary(totalCount: number, returnedCount: number) {
  return { total_count: totalCount, truncated: totalCount > returnedCount };
}
