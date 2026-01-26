/**
 * Import Transactions Tool
 *
 * Triggers the import of transactions from linked bank accounts.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';

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
  description: `Trigger import of transactions from linked bank accounts.

Use when the user asks:
- "Import my bank transactions"
- "Sync my accounts"
- "Get latest transactions from my bank"
- "Refresh bank connections"
- "Pull in new transactions"

Initiates a file-based import for accounts that have direct import enabled.
Returns the count of transactions that were imported.

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
 * Handler for the ynab_import_transactions tool.
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
      message:
        importedIds.length > 0
          ? `Successfully imported ${importedIds.length} transaction(s)`
          : 'No new transactions to import',
      imported_count: importedIds.length,
      ...(validated.include_ids ? { transaction_ids: importedIds } : {}),
      note: 'Imported transactions may need to be categorized',
    },
    null,
    2
  );
}
