/**
 * #94's atomic sign-in at storage level, for #64b's tests: a client, a grant
 * of a given level and a staged sign-in, completed by saving its
 * authorization code (`saveAuthorizationCode` → `applySignIn`).
 */

import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { GrantedScope, OAuthRowStore, OAuthRowWrite, Storage } from '../../../src/storage/types.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';

export type Store = Storage & OAuthRowStore;

const RESOURCE = 'https://mcp.example.com/mcp';
export const BLANK_ROW = {
  payload: '{}',
  grantId: undefined,
  accountId: undefined,
  clientId: undefined,
  uid: undefined,
  expiresAt: undefined,
};

/** A grant payload as the library writes one for the consent choice (D7). */
function grantPayload(scope: GrantedScope, accountId: string, clientId: string): string {
  return JSON.stringify(
    scope === 'read-write'
      ? { accountId, clientId, resources: { [RESOURCE]: 'read-only read-write' } }
      : { accountId, clientId, resources: { [RESOURCE]: 'read-only' }, rejected: { resources: { [RESOURCE]: 'read-write' } } }
  );
}

export interface SignIn {
  grantId: string;
  code: OAuthRowWrite;
}

/** A client, a grant of `scope` for `userId`, and a sign-in staged with YNAB token ciphertext `token`; returns its code row. */
export async function staged(store: Store, userId: string, scope: GrantedScope, token: string): Promise<SignIn> {
  const clientId = `c-${randomUUID()}`;
  const grantId = `g-${randomUUID()}`;
  await store.upsertOAuthRow({ ...BLANK_ROW, key: plainRowKey('Client', clientId), model: 'Client', clientId });
  await store.upsertOAuthRow({
    ...BLANK_ROW,
    key: plainRowKey('Grant', grantId),
    model: 'Grant',
    payload: grantPayload(scope, userId, clientId),
    grantId,
    accountId: userId,
    clientId,
    expiresAt: Date.now() + 3_600_000,
  });
  expect(
    await store.stageSignIn({
      grantId,
      user: { userId, grantedScope: scope, encryptedRefreshToken: token, updatedAt: Date.now() },
      expiresAt: Date.now() + 60_000,
    })
  ).toBe(true);
  return {
    grantId,
    code: {
      ...BLANK_ROW,
      key: `h1.${randomUUID()}`,
      model: 'AuthorizationCode',
      grantId,
      accountId: userId,
      clientId,
      expiresAt: Date.now() + 600_000,
    },
  };
}

/** {@link staged}, then its code saved: the sign-in completes. */
export async function complete(store: Store, userId: string, scope: GrantedScope, token: string): Promise<SignIn> {
  const signIn = await staged(store, userId, scope, token);
  expect(await store.saveAuthorizationCode(signIn.code)).toBe('saved');
  return signIn;
}

/** The user's stored YNAB token ciphertext and level. */
export async function stored(store: Store, userId: string) {
  const user = await store.getUser(userId);
  return { token: user?.encryptedRefreshToken, scope: user?.grantedScope };
}
