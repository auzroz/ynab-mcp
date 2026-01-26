/**
 * Get Transaction Tool
 *
 * Returns details about a specific transaction.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName, sanitizeMemo } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  transaction_id: z.string().uuid().describe('The transaction UUID to retrieve'),
});

// Tool definition
export const getTransactionTool: Tool = {
  name: 'ynab_get_transaction',
  description: `Get details about a specific transaction.

Use when the user asks:
- "Show me details for that transaction"
- "What's the info on transaction [id]?"
- "Tell me more about that purchase"

Requires a transaction_id. Use ynab_list_transactions first to find the transaction ID.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      transaction_id: {
        type: 'string',
        description: 'The transaction UUID to retrieve',
      },
    },
    required: ['transaction_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_get_transaction tool.
 */
export async function handleGetTransaction(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getTransactionById(budgetId, validated.transaction_id);
  const txn = response.data.transaction;

  return JSON.stringify(
    {
      transaction: {
        id: txn.id,
        date: txn.date,
        amount: formatCurrency(txn.amount),
        memo: sanitizeMemo(txn.memo),
        payee_id: txn.payee_id,
        payee_name: sanitizeName(txn.payee_name),
        category_id: txn.category_id,
        category_name: sanitizeName(txn.category_name),
        account_id: txn.account_id,
        account_name: sanitizeName(txn.account_name),
        cleared: txn.cleared,
        approved: txn.approved,
        flag_color: txn.flag_color,
        import_id: txn.import_id,
        import_payee_name: sanitizeName(txn.import_payee_name),
        import_payee_name_original: sanitizeName(txn.import_payee_name_original),
        debt_transaction_type: txn.debt_transaction_type,
        transfer_account_id: txn.transfer_account_id,
        transfer_transaction_id: txn.transfer_transaction_id,
        matched_transaction_id: txn.matched_transaction_id,
        subtransactions:
          (txn.subtransactions ?? []).length > 0
            ? (txn.subtransactions ?? []).map((sub) => ({
                id: sub.id,
                transaction_id: sub.transaction_id,
                amount: formatCurrency(sub.amount),
                memo: sanitizeMemo(sub.memo),
                payee_id: sub.payee_id,
                payee_name: sanitizeName(sub.payee_name),
                category_id: sub.category_id,
                category_name: sanitizeName(sub.category_name),
                transfer_account_id: sub.transfer_account_id,
                transfer_transaction_id: sub.transfer_transaction_id,
              }))
            : [],
      },
    },
    null,
    2
  );
}
