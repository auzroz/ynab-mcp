/**
 * Import Transactions Tool (DEPRECATED)
 *
 * YNAB API 1.88 deprecated POST /plans/{id}/transactions/import. The endpoint
 * no longer does anything and always returns an empty transaction_ids list,
 * because YNAB imports linked accounts automatically. The tool stays registered
 * for backward compatibility; removal is planned for a later release.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';

export const IMPORT_DEPRECATION_MESSAGE =
  'This tool is deprecated. YNAB API 1.88 no longer performs file-based imports; ' +
  'linked accounts are imported automatically by YNAB. No action was taken.';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  include_ids: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include imported transaction IDs in the response'),
});

// Tool definition
export const importTransactionsTool: Tool = {
  name: 'ynab_import_transactions',
  description: `DEPRECATED: This tool no longer imports anything. YNAB API 1.88 deprecated the transaction import endpoint; it does nothing and always returns an empty result. YNAB imports linked bank accounts automatically.

Do NOT use this tool to sync, refresh, or pull in bank transactions. It will not fetch new transactions. To review recent transactions, use ynab_list_transactions instead.

Kept registered for backward compatibility only. Returns deprecated: true with an explanatory message and an imported_count of 0.

Note: This is a WRITE operation that requires write mode to be enabled.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      include_ids: {
        type: 'boolean',
        description: 'Include imported transaction IDs in the response',
      },
    },
    required: [],
  },
};

// Handler function
/**
 * Handler for the ynab_import_transactions tool (deprecated).
 */
export async function handleImportTransactions(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.importTransactions(budgetId);
  const importedIds = response.data.transaction_ids ?? [];

  return JSON.stringify(
    {
      success: true,
      deprecated: true,
      message: IMPORT_DEPRECATION_MESSAGE,
      imported_count: importedIds.length,
      ...(validated.include_ids ? { transaction_ids: importedIds } : {}),
      note: 'Use ynab_list_transactions to review recent transactions. Linked accounts sync automatically in YNAB.',
    },
    null,
    2
  );
}
