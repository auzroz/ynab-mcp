/**
 * Who may call the account tools (#53c). This is the one place it is decided.
 *
 * Until the maintainer decides, the restrictive reading applies. Revoking a
 * connection and disconnecting change the user's account, so they need what a
 * YNAB write needs: a read-write grant on this connection (and a read-write
 * YNAB connection for the user), and writes enabled by the operator
 * (`YNAB_READ_ONLY` off, `YNAB_OAUTH_ALLOW_WRITE` on).
 * Listing connections is allowed on any grant. Neither tool counts against the
 * write cap (#61c), because neither makes a YNAB request.
 *
 * To allow every grant instead, set {@link ACCOUNT_CHANGES_NEED_WRITE_ACCESS}
 * to false. tools/list hides a refused tool, and tools/call refuses it
 * (src/server.ts), so nothing else changes.
 */

import type { GrantedScope } from '../../storage/types.js';

/** The account tools, registered only in OAuth HTTP mode. */
export const ACCOUNT_TOOL_NAMES = ['ynab_list_connections', 'ynab_revoke_connection', 'ynab_disconnect'] as const;
export type AccountToolName = (typeof ACCOUNT_TOOL_NAMES)[number];

/** The pending decision. True is the restrictive answer, the default for now. */
export const ACCOUNT_CHANGES_NEED_WRITE_ACCESS = true;

/** What the policy looks at for one request. */
export interface AccountToolAccess {
  /** This request's grant: read-write only when both the connection's grant (its access token's level) and the user's YNAB grant are. */
  grantScope: GrantedScope;
  /** The operator's setting: `YNAB_READ_ONLY` on, or `YNAB_OAUTH_ALLOW_WRITE` off. */
  operatorReadOnly: boolean;
}

/** Why a call is refused, as the error names it. */
export type AccountToolDenial = 'scope' | 'read_only';

/** Why `tool` may not run for this request, or undefined when it may. */
export function accountToolDenial(
  tool: AccountToolName,
  access: AccountToolAccess,
  needWriteAccess: boolean = ACCOUNT_CHANGES_NEED_WRITE_ACCESS
): AccountToolDenial | undefined {
  if (tool === 'ynab_list_connections' || !needWriteAccess) return undefined;
  // The operator's setting is named first, as it is for YNAB writes.
  if (access.operatorReadOnly) return 'read_only';
  if (access.grantScope !== 'read-write') return 'scope';
  return undefined;
}

/** Whether `tool` may run for this request. */
export function accountToolAllowed(
  tool: AccountToolName,
  access: AccountToolAccess,
  needWriteAccess: boolean = ACCOUNT_CHANGES_NEED_WRITE_ACCESS
): boolean {
  return accountToolDenial(tool, access, needWriteAccess) === undefined;
}
