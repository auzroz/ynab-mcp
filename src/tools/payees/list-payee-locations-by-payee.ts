/**
 * List Payee Locations By Payee Tool
 *
 * Lists all locations for a specific payee.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeString } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  payee_id: z.string().uuid('Invalid payee UUID format').describe('The payee UUID'),
});

// Tool definition
export const listPayeeLocationsByPayeeTool: Tool = {
  name: 'ynab_list_payee_locations_by_payee',
  description: `List all locations for a specific payee.

Use when the user asks:
- "Where is [payee] located?"
- "Show locations for [store]"
- "Which [payee] locations have I visited?"

Returns all recorded locations for a specific payee.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      payee_id: {
        type: 'string',
        description: 'The payee UUID',
      },
    },
    required: ['payee_id'],
  },
};

// Handler function
/**
 * Handler for the ynab_list_payee_locations_by_payee tool.
 */
export async function handleListPayeeLocationsByPayee(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayeeLocationsByPayee(budgetId, validated.payee_id);
  const locations = response.data.payee_locations;

  return JSON.stringify(
    {
      payee_id: sanitizeString(validated.payee_id) ?? '',
      location_count: locations.length,
      payee_locations: locations.map((loc) => ({
        id: sanitizeString(loc.id) ?? '',
        latitude: loc.latitude,
        longitude: loc.longitude,
      })),
    },
    null,
    2
  );
}
