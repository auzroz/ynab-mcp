/**
 * List Connections Tool (#53c)
 *
 * The MCP clients the authenticated user has connected to this server: one
 * entry per live grant. Only the caller's own grants are listed, from the
 * session's user id. No token values or hashes are shown. The only id shown
 * is `family_id`, which ynab_revoke_connection takes.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { ConnectionRecord } from '../../storage/types.js';
import { displayClientName } from '../../auth/client-metadata.js';
import { isMetadataDocumentClientId } from '../../auth/client-id-url.js';
import { sanitizeString } from '../../utils/sanitize.js';
import type { AccountToolContext } from './context.js';
import { toOutputSchema } from '../output-schema.js';

const inputSchema = z.object({}).strict();

const connectionSchema = z.object({
  family_id: z.string().describe('Pass to ynab_revoke_connection'),
  client_name: z.string().nullable().describe('What the app calls itself (not verified); null when it gave no name'),
  client_host: z.string().nullable().describe("The app's web host when it is identified by a URL; null otherwise"),
  access: z.string().describe('read-only or read-write (a stored value, so a string)'),
  connected_at: z.string().nullable(),
  last_used_at: z.string().nullable().describe('When the app last signed in or refreshed; null when unknown'),
  expires_at: z.string().nullable().describe('When the connection expires unless used; null when unknown'),
  this_connection: z.boolean().describe('True for the connection making this call'),
});
type ConnectionOutput = z.output<typeof connectionSchema>;

/** What the tool returns (#45; rules in ../output-schema.ts). Nulls are reported on purpose. */
export const listConnectionsOutputSchema = z.object({
  connections: z.array(connectionSchema),
  summary: z.object({
    count: z.number().int(),
    read_write_count: z.number().int(),
    read_only_count: z.number().int(),
    message: z.string(),
    note: z.string(),
  }),
});
export type ListConnectionsOutput = z.output<typeof listConnectionsOutputSchema>;

export const listConnectionsTool: Tool = {
  name: 'ynab_list_connections',
  description: `List the apps (MCP clients) connected to this server under your YNAB account.

Use when the user asks:
- "Which apps are connected to my budget?"
- "What has access to my YNAB data through this server?"
- "When did I connect this, and when does it expire?"
- "Is anything else still connected?"

Each entry shows the client's name as it declared it (not verified), the client's web host when it identifies itself by a URL, when it was connected, when it last signed in or refreshed, when it expires unless used, and its access level (read-only or read-write). The entry marked this_connection is the client making this call. Pass an entry's family_id to ynab_revoke_connection to remove that one connection, or use ynab_disconnect to remove all of them and erase your data on this server.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  outputSchema: toOutputSchema(listConnectionsOutputSchema),
};

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

/** The host of a client identified by a metadata-document URL (#46); undefined for a registered client. */
function clientHost(clientId: string): string | undefined {
  if (!isMetadataDocumentClientId(clientId)) return undefined;
  try {
    return new URL(clientId).host;
  } catch {
    return undefined;
  }
}

/** One connection as the tool shows it. Every string from a client is sanitized. */
function present(c: ConnectionRecord, currentFamilyId: string | undefined): ConnectionOutput {
  const name = displayClientName(c.clientName);
  const host = clientHost(c.clientId);
  return {
    // Never null for a stored id; `?? ''` is for the type only.
    family_id: sanitizeString(c.familyId, 64) ?? '',
    client_name: name === undefined ? null : sanitizeString(name, 200),
    client_host: host === undefined ? null : sanitizeString(host, 255),
    access: c.grantedScope,
    connected_at: iso(c.createdAt),
    last_used_at: iso(c.lastUsedAt),
    expires_at: iso(c.expiresAt),
    this_connection: currentFamilyId !== undefined && c.familyId === currentFamilyId,
  };
}

export async function handleListConnections(
  args: Record<string, unknown>,
  ctx: AccountToolContext
): Promise<ListConnectionsOutput> {
  inputSchema.parse(args);
  const connections = (await ctx.accounts.listConnections(ctx.userId)).map((c) => present(c, ctx.currentFamilyId));
  const readWrite = connections.filter((c) => c.access === 'read-write').length;
  return {
    connections,
    summary: {
      count: connections.length,
      read_write_count: readWrite,
      read_only_count: connections.length - readWrite,
      message:
        connections.length === 1
          ? 'One app is connected under your account.'
          : `${connections.length} apps are connected under your account.`,
      note: 'client_name is what each app calls itself. client_host, when present, is the web host the app is identified by. last_used_at is when the app last signed in or refreshed its access.',
    },
  };
}
