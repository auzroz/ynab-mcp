/**
 * List Payee Locations Tool
 *
 * Lists all payee locations for a budget (used for map features).
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { sanitizeString } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { toOutputSchema } from '../output-schema.js';
import { count } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const listPayeeLocationsOutputSchema = z.object({
  location_count: count(),
  payee_locations: z.array(
    z.object({ id: z.string(), payee_id: z.string(), latitude: z.string(), longitude: z.string() })
  ),
});
export type ListPayeeLocationsOutput = z.output<typeof listPayeeLocationsOutputSchema>;

// Tool definition
export const listPayeeLocationsTool: Tool = {
  name: 'ynab_list_payee_locations',
  description: `List all payee locations for a budget.

Use when the user asks:
- "Where are my payees located?"
- "Show payee locations"
- "Map of where I spend"
- "Payee geographic data"

Returns payee locations with latitude/longitude for mapping purposes.

Not possible through the YNAB API (do it in the YNAB app): adding, editing or deleting payee locations.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
  outputSchema: toOutputSchema(listPayeeLocationsOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_list_payee_locations tool.
 */
export async function handleListPayeeLocations(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<ListPayeeLocationsOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayeeLocations(budgetId);
  const locations = response.data.payee_locations;

  return {
    location_count: locations.length,
    payee_locations: locations.map((loc) => ({
      id: sanitizeString(loc.id) ?? '',
      payee_id: sanitizeString(loc.payee_id) ?? '',
      latitude: loc.latitude,
      longitude: loc.longitude,
    })),
  };
}
