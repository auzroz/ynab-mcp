/**
 * Import Transactions Tool (DEPRECATED)
 *
 * YNAB API 1.88 deprecated POST /plans/{id}/transactions/import, which imported
 * transactions from linked accounts. The endpoint no longer does anything and
 * always returns an empty transaction_ids list, because YNAB now imports linked
 * accounts automatically. The tool stays registered for backward compatibility
 * and returns that empty result without calling the API, so it also works in
 * read-only mode. Removal is planned for a later release.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { budgetId } from '../../utils/schemas.js';

export const IMPORT_DEPRECATION_MESSAGE =
  'This tool is deprecated. YNAB API 1.88 retired the linked-account import endpoint ' +
  'because YNAB now imports linked accounts automatically. No action was taken.';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
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

Kept registered for backward compatibility only. Makes no API call and returns deprecated: true with an explanatory message and an imported_count of 0.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
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
  // Validate budget_id the same way as other tools; the API is not called because
  // the endpoint is a no-op since YNAB API 1.88.
  client.resolveBudgetId(validated.budget_id);
  const importedIds: string[] = [];

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
