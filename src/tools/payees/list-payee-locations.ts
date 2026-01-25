/**
 * List Payee Locations Tool
 *
 * Lists all payee locations for a budget (used for map features).
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
});

// Tool definition
export const listPayeeLocationsTool: Tool = {
  name: 'ynab_list_payee_locations',
  description: `List all payee locations for a budget.

Use when the user asks:
- "Where are my payees located?"
- "Show payee locations"
- "Map of where I spend"
- "Payee geographic data"

Returns payee locations with latitude/longitude for mapping purposes.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
};

// Handler function
export async function handleListPayeeLocations(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayeeLocations(budgetId);
  const locations = response.data.payee_locations;

  return JSON.stringify(
    {
      location_count: locations.length,
      payee_locations: locations.map((loc) => ({
        id: loc.id,
        payee_id: loc.payee_id,
        latitude: loc.latitude,
        longitude: loc.longitude,
      })),
    },
    null,
    2
  );
}
