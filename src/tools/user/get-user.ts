/**
 * Get User Tool
 *
 * Returns information about the authenticated user.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { toOutputSchema } from '../output-schema.js';

// Input schema (no parameters needed)
const inputSchema = z.object({}).strict();

/** What the tool returns (#45; rules in ../output-schema.ts). */
export const getUserOutputSchema = z.object({
  user: z.object({ id: z.string() }),
});
export type GetUserOutput = z.output<typeof getUserOutputSchema>;

// Tool definition
export const getUserTool: Tool = {
  name: 'ynab_get_user',
  description: `Get information about the authenticated YNAB user.

Use when the user asks:
- "Who am I logged in as?"
- "What's my YNAB user ID?"
- "Show my user ID"

Returns the user's ID.`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  outputSchema: toOutputSchema(getUserOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_get_user tool.
 */
export async function handleGetUser(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<GetUserOutput> {
  inputSchema.parse(args);

  const response = await client.getUser();
  const user = response.data.user;

  return {
    user: {
      id: user.id,
    },
  };
}
