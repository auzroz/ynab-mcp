/**
 * What the account tools (#53c) run with: the authenticated user's
 * AccountStore handle and who is calling. http.ts builds one per OAuth
 * request, and only in OAuth mode. Stdio and header mode have no connections,
 * so they build none and the tools are not registered there.
 */

import type { AccountStore, GrantedScope } from '../../storage/types.js';
import type { AuditLog } from '../../services/audit-log.js';
import type { AccountToolAccess } from './policy.js';

export interface AccountToolContext extends AccountToolAccess {
  /**
   * The only way the tools reach storage. Every method is scoped to the user
   * it is given, and the tools always pass `userId` from the session, never
   * an id taken from tool input.
   */
  readonly accounts: AccountStore;
  /** The authenticated YNAB user id, from the verified access token. */
  readonly userId: string;
  /** The calling connection's grant id (the access token's), used to mark the caller's own entry. */
  readonly currentFamilyId: string | undefined;
  readonly grantScope: GrantedScope;
  readonly operatorReadOnly: boolean;
  /**
   * Called after the account is erased. It drops the per-user state this
   * replica holds: the registry entry (limiter, caches, memory audit rows)
   * and the YNAB token resolver's cached token.
   */
  readonly afterDisconnect: () => Promise<void>;
}

/**
 * What http.ts puts in a request's context (OAuth mode). The AccountStore is
 * opened per request on that request's audit log (built in
 * `createServerForRequest`), so whatever AccountStore records names the
 * request's user, client, grant and request id.
 */
export interface AccountToolSetup extends Omit<AccountToolContext, 'accounts'> {
  readonly openAccounts: (auditLog: AuditLog) => AccountStore;
}

/**
 * An account tool's handler: like the others, it returns its output object
 * (#45), which the caller serializes for the text block and sends as
 * structuredContent.
 */
export type AccountToolHandler = (args: Record<string, unknown>, ctx: AccountToolContext) => Promise<Record<string, unknown>>;
