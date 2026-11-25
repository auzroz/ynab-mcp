/**
 * Disconnect Tool (#53c)
 *
 * Erases the authenticated user's account on this server
 * (AccountStore.deleteUserData). That covers the stored YNAB tokens, every
 * connection and its tokens, codes and tombstones, and the user's audit rows.
 * It then drops what this replica keeps for the user in memory. It needs the
 * literal `confirm: "DISCONNECT"`. No audit event is written: the erase
 * removes the user's audit rows anyway.
 *
 * The YNAB authorization itself lives at YNAB, so the reply tells the user how
 * to revoke it there, with the consent page's wording.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import { YNAB_REVOKE_STEPS } from '../../auth/ynab-revoke-text.js';
import { sanitizeErrorMessage } from '../../utils/sanitize.js';
import type { AccountToolContext } from './context.js';

/** The confirmation the call must carry, exactly. */
export const DISCONNECT_CONFIRMATION = 'DISCONNECT';

const inputSchema = z
  .object({
    // z.unknown, so a missing value gets the same message as a wrong one.
    confirm: z.unknown().refine((v) => v === DISCONNECT_CONFIRMATION, {
      message: `confirm must be exactly "${DISCONNECT_CONFIRMATION}"`,
    }),
  })
  .strict();

/** The fixed text of a failed erase. Storage errors are logged, not returned. */
export const DISCONNECT_FAILED_MESSAGE = 'Could not disconnect; nothing was erased. Try again shortly.';

export const disconnectTool: Tool = {
  name: 'ynab_disconnect',
  description: `Disconnect your YNAB account from this server and erase what it stores for you.

Use when the user asks:
- "Disconnect my YNAB account from this server"
- "Delete my data from this server"
- "Remove all access this server has to my budget"
- "I want to stop using this server"

Revokes every connection under your account, including the one making this call, and erases your stored YNAB tokens and your audit log on this server. It cannot be undone. To use the server again, you sign in again from the start. Nothing in your YNAB budget is changed. Ask the user to confirm first, then call with confirm set to exactly "DISCONNECT". The YNAB authorization itself has to be revoked at YNAB, and the reply says how.`,
  inputSchema: {
    type: 'object',
    properties: {
      confirm: {
        type: 'string',
        const: DISCONNECT_CONFIRMATION,
        description: 'Must be exactly "DISCONNECT", after the user has confirmed',
      },
    },
    required: ['confirm'],
    additionalProperties: false,
  },
};

export async function handleDisconnect(args: Record<string, unknown>, ctx: AccountToolContext): Promise<string> {
  inputSchema.parse(args);
  try {
    // One transaction on every driver: all of it is erased, or none.
    await ctx.accounts.deleteUserData(ctx.userId);
  } catch (error) {
    console.error('[Disconnect] Account erase failed:', sanitizeErrorMessage(error));
    throw new Error(DISCONNECT_FAILED_MESSAGE, { cause: error });
  }
  await ctx.afterDisconnect();
  return JSON.stringify(
    {
      disconnected: true,
      message:
        'Disconnected. Every connection under your account on this server is revoked, including this one, and the server has erased your stored YNAB tokens, your connections and your audit log. Your YNAB budget is unchanged.',
      ynab_authorization: `This server is still listed as authorized in your YNAB account. To remove it there too, ${YNAB_REVOKE_STEPS}`,
      next_step: 'To use this server again later, connect and sign in again from the start.',
    },
    null,
    2
  );
}
