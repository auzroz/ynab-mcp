/**
 * The account tools' (#53b) only handle on storage. Every method is scoped to
 * the user it is given, which the tool takes from the authenticated session,
 * never from tool input; another user's family id is a no-op. The unscoped
 * `Storage.deleteTokenFamily` (the provider's reuse detection) is not
 * reachable from here, and the returned object holds no reference a caller
 * could use to reach the rest of `Storage`.
 */

import type { AccountStore, Storage } from './types.js';

export function createAccountStore(storage: Storage): AccountStore {
  return Object.freeze({
    listConnections: (userId: string) => storage.listConnections(userId),
    revokeUserFamily: (userId: string, familyId: string) => storage.revokeUserFamily(userId, familyId),
    deleteTokenFamiliesForClient: (userId: string, clientId: string) =>
      storage.deleteTokenFamiliesForClient(userId, clientId),
    deleteUserData: (userId: string) => storage.deleteUserData(userId),
  });
}
