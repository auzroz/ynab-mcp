/**
 * Resolves an authenticated user's current YNAB access token for a request.
 *
 * Given a YNAB user id (from the verified MCP access token), loads the user's
 * encrypted YNAB refresh token, returns a cached access token if still fresh, or
 * refreshes against YNAB — persisting the rotated refresh token, since YNAB issues
 * a new refresh token on every refresh.
 */

import type { Storage, GrantedScope } from '../storage/types.js';
import type { Encryptor } from '../crypto.js';
import { refreshAccessToken, type YnabOAuthConfig } from './ynab-oauth.js';

/** Refresh a bit early so an access token doesn't expire mid-request. */
const REFRESH_SKEW_MS = 60_000;

export interface ResolvedUser {
  accessToken: string;
  grantedScope: GrantedScope;
}

export class YnabTokenResolver {
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number }>();

  constructor(
    private readonly storage: Storage,
    private readonly encryptor: Encryptor,
    private readonly ynab: YnabOAuthConfig
  ) {}

  async resolve(userId: string): Promise<ResolvedUser> {
    const user = await this.storage.getUser(userId);
    if (!user) {
      throw new Error('Unknown user: re-authorize the YNAB connection');
    }

    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now() + REFRESH_SKEW_MS) {
      return { accessToken: cached.accessToken, grantedScope: user.grantedScope };
    }

    const refreshToken = this.encryptor.decrypt(user.encryptedRefreshToken);
    const set = await refreshAccessToken(this.ynab, refreshToken);

    // YNAB rotates the refresh token on every refresh — persist the new one.
    await this.storage.upsertUser({
      ...user,
      encryptedRefreshToken: this.encryptor.encrypt(set.refreshToken),
      updatedAt: Date.now(),
    });
    this.cache.set(userId, { accessToken: set.accessToken, expiresAt: set.expiresAt });

    return { accessToken: set.accessToken, grantedScope: user.grantedScope };
  }

  /** Drop any cached access token for a user (e.g. after disconnect). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
