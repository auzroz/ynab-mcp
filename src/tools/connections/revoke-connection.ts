/**
 * Revoke Connection Tool (#53c)
 *
 * Revokes one of the authenticated user's connections (a grant, or a 0.4.x
 * token family) by its `family_id`. The revoke is scoped to the session's
 * user: an id of another user's connection gets exactly the same not-found
 * reply as an unknown id, so the tool can't be used to learn whether an id
 * exists. Revoking goes only through AccountStore.revokeUserFamily, which
 * records it in the audit log (#60b).
 *
 * The caller may revoke its own current connection. That is allowed: the
 * reply says so, and from the next request on the client's tokens are
 * refused, so it must sign in again.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import { ConnectionNotFoundError } from '../../utils/errors.js';
import type { AccountToolContext } from './context.js';
import { toOutputSchema } from '../output-schema.js';

/**
 * A connection id as the server issues them: an oidc-provider grant id (43
 * base64url characters) or a 0.4.x family id (a UUID). Anything else is
 * refused before storage is read.
 */
const FAMILY_ID = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{43}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/, {
    message: 'family_id must be an id from ynab_list_connections',
  });

const inputSchema = z.object({ family_id: FAMILY_ID }).strict();

/** What the tool returns (#45; rules in ../output-schema.ts). An unknown id is a tool error, not a result. */
export const revokeConnectionOutputSchema = z.object({
  revoked: z.literal(true),
  family_id: z.string(),
  this_connection: z.boolean().describe('True when the caller revoked its own connection: it must sign in again'),
  message: z.string(),
});
export type RevokeConnectionOutput = z.output<typeof revokeConnectionOutputSchema>;

export const revokeConnectionTool: Tool = {
  name: 'ynab_revoke_connection',
  description: `Revoke one app's connection to this server, by the family_id from ynab_list_connections.

Use when the user asks:
- "Disconnect [app] from my budget"
- "Remove that old connection"
- "Revoke access for the app I don't use any more"
- "I lost the device that had this connected"

That app's tokens stop working at once. To use this server again, the app must sign in again. Your other connections and your data on this server are not affected. The connection making this call can revoke itself, and the reply says so when it does. This does not remove the server's access at YNAB (see ynab_disconnect).`,
  inputSchema: {
    type: 'object',
    properties: {
      family_id: {
        type: 'string',
        description: 'The connection to revoke: a family_id from ynab_list_connections',
      },
    },
    required: ['family_id'],
    additionalProperties: false,
  },
  outputSchema: toOutputSchema(revokeConnectionOutputSchema),
};

export async function handleRevokeConnection(
  args: Record<string, unknown>,
  ctx: AccountToolContext
): Promise<RevokeConnectionOutput> {
  const { family_id: familyId } = inputSchema.parse(args);
  // Scoped by the session's user. Another user's id and an unknown one both come back false.
  if (!(await ctx.accounts.revokeUserFamily(ctx.userId, familyId))) throw new ConnectionNotFoundError();
  const own = ctx.currentFamilyId !== undefined && familyId === ctx.currentFamilyId;
  return {
    revoked: true,
    family_id: familyId,
    this_connection: own,
    message: own
      ? 'Revoked. This was the connection making this call: its tokens no longer work, and this app must sign in again to keep using this server.'
      : "Revoked. That app's tokens no longer work. Your other connections are not affected.",
  };
}
