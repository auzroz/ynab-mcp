/**
 * Who may call the account tools (#53c). This is the one place it is decided.
 *
 * Maintainer decision (2026-11-25): any connection may list, revoke and
 * disconnect, read-only grants included, whatever the operator's write
 * settings. The consent page promises the user can disconnect at any time, and
 * on a default instance (writes off) every grant is read-only, so requiring
 * write access would leave revoke and disconnect unreachable. None of the three
 * changes budget data or makes a YNAB request, so neither the YNAB read-only
 * settings nor the write cap (#61c) apply. The cost: a read-only client can
 * end the user's other connections here or erase the account on this server;
 * YNAB's own authorization is untouched.
 *
 * The restrictive reading (revoke and disconnect need writes enabled and a
 * read-write grant) is kept behind {@link ACCOUNT_CHANGES_NEED_WRITE_ACCESS}
 * and tested, so it stays a one-line change. tools/list hides a refused tool,
 * and tools/call refuses it (src/server.ts).
 */

import type { GrantedScope } from '../../storage/types.js';

/** The account tools, registered only in OAuth HTTP mode. */
export const ACCOUNT_TOOL_NAMES = ['ynab_list_connections', 'ynab_revoke_connection', 'ynab_disconnect'] as const;
export type AccountToolName = (typeof ACCOUNT_TOOL_NAMES)[number];

/** False: every grant may revoke and disconnect (maintainer decision, 2026-11-25). True is the restrictive reading. */
export const ACCOUNT_CHANGES_NEED_WRITE_ACCESS = false;

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
