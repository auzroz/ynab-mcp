/**
 * Get Payee Location Tool
 *
 * Gets a specific payee location by ID.
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
  payee_location_id: z.string().uuid().describe('The payee location UUID'),
});

// Tool definition
export const getPayeeLocationTool: Tool = {
  name: 'ynab_get_payee_location',
  description: `Get a specific payee location by ID.

Returns the details of a single payee location including coordinates.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      payee_location_id: {
        type: 'string',
        description: 'The payee location UUID',
      },
    },
    required: ['payee_location_id'],
  },
};

// Handler function
export async function handleGetPayeeLocation(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  const response = await client.getPayeeLocationById(budgetId, validated.payee_location_id);
  const loc = response.data.payee_location;

  return JSON.stringify(
    {
      payee_location: {
        id: loc.id,
        payee_id: loc.payee_id,
        latitude: loc.latitude,
        longitude: loc.longitude,
      },
    },
    null,
    2
  );
}
