/**
 * Get Transaction Tool
 *
 * Returns details about a specific transaction.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import { budgetId, ynabId } from '../../utils/schemas.js';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { sanitizeFlagName } from './format.js';
import { sanitizeName, sanitizeMemo, sanitizeString } from '../../utils/sanitize.js';
import { omitNull } from '../../utils/omit-null.js';
import { toOutputSchema } from '../output-schema.js';
import { fromYnab, money } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transaction_id: ynabId().describe('The transaction UUID to retrieve'),
});

const OMITTED = 'Omitted when YNAB has no value';

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const getTransactionOutputSchema = z.object({
  transaction: z.object({
    id: fromYnab(z.string()),
    date: fromYnab(z.string()),
    amount: money(),
    memo: z.string().nullable(),
    payee_id: z.string().exactOptional().describe(OMITTED),
    payee_name: z.string(),
    category_id: z.string().exactOptional().describe(OMITTED),
    category_name: z.string(),
    account_id: fromYnab(z.string()),
    account_name: z.string(),
    cleared: fromYnab(z.string().describe('YNAB cleared status: cleared, uncleared or reconciled')),
    approved: fromYnab(z.boolean()),
    flag_color: z.string().exactOptional().describe('YNAB flag colour; omitted when unflagged'),
    flag_name: z.string().nullable(),
    import_id: z.string().nullable(),
    import_payee_name: z.string(),
    import_payee_name_original: z.string(),
    debt_transaction_type: z.string().exactOptional().describe(OMITTED),
    transfer_account_id: z.string().exactOptional().describe(OMITTED),
    transfer_transaction_id: z.string().exactOptional().describe(OMITTED),
    matched_transaction_id: z.string().exactOptional().describe(OMITTED),
    subtransactions: z.array(
      z.object({
        id: fromYnab(z.string()),
        transaction_id: fromYnab(z.string()),
        amount: money(),
        memo: z.string().nullable(),
        payee_id: z.string().exactOptional().describe(OMITTED),
        payee_name: z.string(),
        category_id: z.string().exactOptional().describe(OMITTED),
        category_name: z.string(),
        transfer_account_id: z.string().exactOptional().describe(OMITTED),
        transfer_transaction_id: z.string().exactOptional().describe(OMITTED),
      })
    ),
  }),
});
export type GetTransactionOutput = z.output<typeof getTransactionOutputSchema>;

// Tool definition
export const getTransactionTool: Tool = {
  name: 'ynab_get_transaction',
  description: `Get details about a specific transaction.

Use when the user asks:
- "Show me details for that transaction"
- "What's the info on transaction [id]?"
- "Tell me more about that purchase"

Requires a transaction_id. Use ynab_list_transactions first to find the transaction ID.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transaction_id: {
        type: 'string',
        maxLength: 36,
        description: 'The transaction UUID to retrieve',
      },
    },
    required: ['transaction_id'],
  },
  outputSchema: toOutputSchema(getTransactionOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_get_transaction tool.
 */
export async function handleGetTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<GetTransactionOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);

  const response = await client.getTransactionById(budgetId, validated.transaction_id);
  const txn = response.data.transaction;

  return {
    transaction: {
      id: txn.id,
      date: txn.date,
      amount: money(txn.amount),
      memo: sanitizeMemo(txn.memo),
      ...omitNull({ payee_id: txn.payee_id }),
      payee_name: sanitizeName(txn.payee_name),
      ...omitNull({ category_id: txn.category_id }),
      category_name: sanitizeName(txn.category_name),
      account_id: txn.account_id,
      account_name: sanitizeName(txn.account_name),
      cleared: txn.cleared,
      approved: txn.approved,
      ...omitNull({ flag_color: txn.flag_color }),
      flag_name: sanitizeFlagName(txn.flag_name),
      import_id: sanitizeString(txn.import_id, 36),
      import_payee_name: sanitizeName(txn.import_payee_name),
      import_payee_name_original: sanitizeName(txn.import_payee_name_original),
      ...omitNull({
        debt_transaction_type: txn.debt_transaction_type,
        transfer_account_id: txn.transfer_account_id,
        transfer_transaction_id: txn.transfer_transaction_id,
        matched_transaction_id: txn.matched_transaction_id,
      }),
      subtransactions:
        (txn.subtransactions ?? []).length > 0
          ? (txn.subtransactions ?? []).map((sub) => ({
              id: sub.id,
              transaction_id: sub.transaction_id,
              amount: money(sub.amount),
              memo: sanitizeMemo(sub.memo),
              ...omitNull({ payee_id: sub.payee_id }),
              payee_name: sanitizeName(sub.payee_name),
              ...omitNull({ category_id: sub.category_id }),
              category_name: sanitizeName(sub.category_name),
              ...omitNull({ transfer_account_id: sub.transfer_account_id, transfer_transaction_id: sub.transfer_transaction_id }),
            }))
          : [],
    },
  };
}
