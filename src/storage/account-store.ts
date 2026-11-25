/**
 * The account tools' (#53b) only handle on storage. Every method is scoped to
 * the user it is given, which the tool takes from the authenticated session,
 * never from tool input; another user's family id is a no-op. The unscoped
 * `Storage.deleteTokenFamily` (the provider's reuse detection) is not
 * reachable from here, and the returned object holds no reference a caller
 * could use to reach the rest of `Storage`.
 *
 * #60b: a revocation through here is one audit row, recorded with the
 * caller's request AuditLog (its user, client, grant and request id, and the
 * tool in progress) and only when the revoke removed something: an unknown or
 * another user's id records nothing. These methods are the only recording
 * point for the account tools' revocations (they don't go through the
 * library, so no `grant.revoked` event fires for them); the tools record
 * none themselves. `deleteUserData` (the erase, `ynab_disconnect`) records
 * nothing: the erase deletes the user's audit rows too (D-7b).
 */

import type { AuditLog } from '../services/audit-log.js';
import type { AccountStore, Storage } from './types.js';

export function createAccountStore(storage: Storage, auditLog: AuditLog): AccountStore {
  // The row goes to the log's user; a revoke for anyone else (never the case:
  // both come from the session) is not misattributed to it.
  const record = async (userId: string, resourceType: 'grant' | 'client', resourceId: string): Promise<void> => {
    if (userId !== auditLog.userId) {
      console.error('[AUDIT] a revocation for another user than the request was not recorded');
      return;
    }
    await auditLog.recordRevocation({ resourceType, resourceId, outcome: 'revoked' });
  };
  return Object.freeze({
    listConnections: (userId: string) => storage.listConnections(userId),
    revokeUserFamily: async (userId: string, familyId: string) => {
      const revoked = await storage.revokeUserFamily(userId, familyId);
      if (revoked) await record(userId, 'grant', familyId);
      return revoked;
    },
    deleteTokenFamiliesForClient: async (userId: string, clientId: string) => {
      const revoked = await storage.deleteTokenFamiliesForClient(userId, clientId);
      // One row for the call: every grant the user gave that client.
      if (revoked > 0) await record(userId, 'client', clientId);
      return revoked;
    },
    // Never with the inactive-user condition: the tool erases unconditionally.
    deleteUserData: async (userId: string) => {
      await storage.deleteUserData(userId);
    },
  });
}
