/**
 * Resolves an authenticated user's current YNAB access token for a request.
 *
 * Given a YNAB user id (from the verified MCP access token), loads the user's
 * encrypted YNAB refresh token, returns a cached access token if still fresh, or
 * refreshes against YNAB — persisting the rotated refresh token, since YNAB issues
 * a new refresh token on every refresh.
 *
 * The write-back is a compare-and-set against the token the refresh started
 * from (`Storage.updateUserRefreshToken`), never an upsert: a refresh that
 * finishes after the user erased their account (`deleteUserData`) cannot bring
 * the row back, and one that finishes after a re-consent or another replica's
 * refresh does not overwrite the newer token.
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
  /**
   * The account generation the token belongs to: the user row's `createdAt`,
   * or 0 for a user from before 0.5.0. It changes only when the account is
   * erased and the user connects again.
   */
  generation: number;
}

/** The user row is gone (erased or never connected): the client must re-authorize. */
const RECONNECT = 'Unknown user: re-authorize the YNAB connection';

function generationOf(user: UserRecord): number {
  return user.createdAt ?? 0;
}

export class YnabTokenResolver {
  // Keyed by user, and only valid for the account generation that minted it:
  // an erased account's token is never served to the account that replaced it.
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number; generation: number }>();
  // Refreshes in progress, per user. Concurrent requests join one refresh: YNAB
  // rotates the refresh token on every refresh, so a parallel second refresh
  // would present an already-used one and fail.
  private readonly refreshing = new Map<string, Promise<ResolvedUser>>();
  // Recent refresh failures, per user, keyed to the refresh token that failed:
  // a newly stored grant (a different token) is tried at once.
  private readonly failed = new Map<string, { encryptedRefreshToken: string; until: number }>();

  constructor(
    private readonly storage: Storage,
    private readonly encryptor: Encryptor,
    private readonly ynab: YnabOAuthConfig,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The user's current YNAB access token and access level. With `generation`
   * (from an earlier resolve), refuses once the account has been erased and
   * re-created since: a session opened under the old account must not borrow
   * the new one's YNAB grant.
   */
  async resolve(userId: string, generation?: number): Promise<ResolvedUser> {
    // Read on every call (also on a cache hit), so a removed grant takes effect
    // on the user's next request.
    const user = await this.storage.getUser(userId);
    if (!user || (generation !== undefined && generationOf(user) !== generation)) {
      throw new Error(RECONNECT);
    }

    const cached = this.cache.get(userId);
    if (
      cached &&
      cached.generation === generationOf(user) &&
      cached.expiresAt > this.now() + REFRESH_SKEW_MS
    ) {
      return { accessToken: cached.accessToken, grantedScope: user.grantedScope, generation: generationOf(user) };
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
    const refreshed = await refreshing;
    // Joined a refresh started from an older row (a re-consent replaced it meanwhile).
    if (generation !== undefined && refreshed.generation !== generation) throw new Error(RECONNECT);
    return refreshed;
  }

  /**
   * A token function for a session's YnabClient: resolves the user's current
   * YNAB access token for each request. Failures become a YnabAuthError (a
   * fixed, mapped client message); the cause is logged sanitized. The account
   * generation seen by the first call is pinned: if the account is erased and
   * re-created while the session lives, later calls fail instead of using the
   * new account's grant.
   */
  accessTokenFor(userId: string): () => Promise<string> {
    let pinned: number | undefined;
    return async () => {
      try {
        const resolved = await this.resolve(userId, pinned);
        pinned ??= resolved.generation;
        return resolved.accessToken;
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

  /**
   * Refresh against YNAB and write the rotated refresh token back with a
   * compare-and-set. On a miss the row is re-read: gone means the account was
   * erased (reconnect error, nothing written); changed means a newer token was
   * stored (a re-consent or another replica's refresh), which wins: the
   * refresh is redone once from it, or refused if the account was re-created.
   */
  private async refresh(user: UserRecord, retried = false): Promise<ResolvedUser> {
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

    // YNAB rotates the refresh token on every refresh — persist the new one,
    // but only over the token this refresh started from.
    const stored = await this.storage.updateUserRefreshToken(
      user.userId,
      user.encryptedRefreshToken,
      this.encryptor.encrypt(set.refreshToken)
    );
    if (!stored) {
      const current = await this.storage.getUser(user.userId);
      if (!current || generationOf(current) !== generationOf(user) || retried) {
        this.invalidate(user.userId);
        throw new Error(RECONNECT);
      }
      return this.refresh(current, true);
    }
    this.cache.set(user.userId, {
      accessToken: set.accessToken,
      expiresAt: set.expiresAt,
      generation: generationOf(user),
    });
    return { accessToken: set.accessToken, grantedScope: user.grantedScope, generation: generationOf(user) };
  }
}
