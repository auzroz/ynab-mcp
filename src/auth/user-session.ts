/**
 * Resolves an authenticated user's current YNAB access token for a request.
 *
 * Given a YNAB user id (from the verified MCP access token), loads the user's
 * encrypted YNAB refresh token, returns a cached access token if still fresh, or
 * refreshes against YNAB — persisting the rotated refresh token, since YNAB issues
 * a new refresh token on every refresh.
 */

import type { Storage, GrantedScope, UserRecord } from '../storage/types.js';
import type { Encryptor } from '../crypto.js';
import { YnabAuthError } from '../utils/errors.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';
import { refreshAccessToken, type YnabOAuthConfig, type YnabTokenSet } from './ynab-oauth.js';

/** Refresh a bit early so an access token doesn't expire mid-request. */
const REFRESH_SKEW_MS = 60_000;

/**
 * How long a failed refresh is remembered. A revoked grant otherwise costs a
 * YNAB token-endpoint call (and a log line) for every YNAB call the user's
 * tools make; short, so a transient failure clears quickly.
 */
const REFRESH_FAILURE_TTL_MS = 30_000;

/** A refresh skipped because the same grant failed moments ago (already logged). */
class RecentRefreshFailureError extends Error {
  constructor() {
    super('YNAB token refresh failed recently: not retrying yet');
    this.name = 'RecentRefreshFailureError';
  }
}

export interface ResolvedUser {
  accessToken: string;
  grantedScope: GrantedScope;
}

export class YnabTokenResolver {
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number }>();
  // Refreshes in progress, per user. Concurrent requests join one refresh: YNAB
  // rotates the refresh token on every refresh, so a parallel second refresh
  // would present an already-used one and fail.
  private readonly refreshing = new Map<string, Promise<string>>();
  // Recent refresh failures, per user, keyed to the refresh token that failed:
  // a newly stored grant (a different token) is tried at once.
  private readonly failed = new Map<string, { encryptedRefreshToken: string; until: number }>();

  constructor(
    private readonly storage: Storage,
    private readonly encryptor: Encryptor,
    private readonly ynab: YnabOAuthConfig,
    private readonly now: () => number = Date.now
  ) {}

  async resolve(userId: string): Promise<ResolvedUser> {
    // Read on every call (also on a cache hit), so a removed grant takes effect
    // on the user's next request.
    const user = await this.storage.getUser(userId);
    if (!user) {
      throw new Error('Unknown user: re-authorize the YNAB connection');
    }

    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > this.now() + REFRESH_SKEW_MS) {
      return { accessToken: cached.accessToken, grantedScope: user.grantedScope };
    }

    const failed = this.failed.get(userId);
    if (failed && failed.until > this.now() && failed.encryptedRefreshToken === user.encryptedRefreshToken) {
      throw new RecentRefreshFailureError();
    }

    let refreshing = this.refreshing.get(userId);
    if (!refreshing) {
      refreshing = this.refresh(user).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, refreshing);
    }
    return { accessToken: await refreshing, grantedScope: user.grantedScope };
  }

  /**
   * A token function for a session's YnabClient: resolves the user's current
   * YNAB access token for each request. Failures become a YnabAuthError (a
   * fixed, mapped client message); the cause is logged sanitized.
   */
  accessTokenFor(userId: string): () => Promise<string> {
    return async () => {
      try {
        return (await this.resolve(userId)).accessToken;
      } catch (error) {
        // A remembered failure was logged when it happened; don't log it per call.
        if (!(error instanceof RecentRefreshFailureError)) {
          console.error('[YnabToken] could not resolve a YNAB access token:', sanitizeErrorMessage(error));
        }
        throw new YnabAuthError();
      }
    };
  }

  /** Drop any cached access token or remembered failure for a user (e.g. after disconnect). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.failed.delete(userId);
  }

  private async refresh(user: UserRecord): Promise<string> {
    let set: YnabTokenSet;
    try {
      const refreshToken = this.encryptor.decrypt(user.encryptedRefreshToken);
      set = await refreshAccessToken(this.ynab, refreshToken);
    } catch (error) {
      this.failed.set(user.userId, {
        encryptedRefreshToken: user.encryptedRefreshToken,
        until: this.now() + REFRESH_FAILURE_TTL_MS,
      });
      throw error;
    }
    this.failed.delete(user.userId);

    // YNAB rotates the refresh token on every refresh — persist the new one.
    await this.storage.upsertUser({
      ...user,
      encryptedRefreshToken: this.encryptor.encrypt(set.refreshToken),
      updatedAt: Date.now(),
    });
    this.cache.set(user.userId, { accessToken: set.accessToken, expiresAt: set.expiresAt });
    return set.accessToken;
  }
}
