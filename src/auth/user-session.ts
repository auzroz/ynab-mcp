/**
 * Resolves an authenticated user's current YNAB access token for a request.
 *
 * Given a YNAB user id (from the verified MCP access token), loads the user's
 * row and returns, in this order: this process's cached access token while it
 * is fresh; the access token another replica shared in the row (#48) while it
 * is fresh; or a new one from a refresh against YNAB, persisting the rotated
 * refresh token, since YNAB issues a new refresh token on every refresh.
 *
 * Refresh-token rotation across replicas (#48, D-3). YNAB spends the refresh
 * token on every refresh, so two replicas refreshing one user at once would
 * leave one of them holding a spent token. Two layers keep it to one refresh:
 *
 *   1. In this process, concurrent requests join one refresh (`refreshing`).
 *   2. Across replicas, a lease on the user row
 *      (`Storage.claimRefreshLease`): a single compare-and-set UPDATE that
 *      takes it only while no unexpired lease holds. The winner refreshes,
 *      with no transaction and no pooled connection held across the YNAB
 *      call, and writes the rotated refresh token, the new access token
 *      (encrypted, AAD-bound to `users.encrypted_access_token`) and its expiry
 *      in one statement that also frees the lease. A replica that loses the
 *      claim polls the row with a bound ({@link REFRESH_LEASE_WAIT_MS}) for
 *      that shared token; it never calls YNAB while the lease holds and no
 *      fresh shared token is there, and fails closed when the wait runs out.
 *      A lease whose holder crashed expires ({@link REFRESH_LEASE_TTL_MS}).
 *      The same code runs on every driver.
 *
 * The write-back is a compare-and-set against the refresh token the refresh
 * started from (`Storage.updateUserRefreshToken`), never an upsert, and that
 * compare-and-set on the stored ciphertext is the version check: a refresh
 * that finishes after the user erased their account (`deleteUserData`) cannot
 * bring the row back, and one that finishes after a re-consent or another
 * replica's refresh does not overwrite the newer token.
 */

import { randomUUID } from 'node:crypto';
import type { Storage, GrantedScope, UserRecord } from '../storage/types.js';
import { accessTokenContext, ciphertextVersion, refreshTokenContext, type Encryptor } from '../crypto.js';
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

/**
 * #48: how long a refresh lease holds. Longer than the YNAB call (10 s at most,
 * `OUTBOUND_TIMEOUT_MS`) plus a worst-case write-back (the Postgres query
 * timeout, 15 s), with margin for clock skew between replicas. A holder that
 * crashed delays the user's next refresh by at most this long.
 */
export const REFRESH_LEASE_TTL_MS = 45_000;

/**
 * #48: how long a replica that lost the claim waits for the holder's shared
 * access token before it fails closed: longer than the YNAB call it waits for.
 */
export const REFRESH_LEASE_WAIT_MS = 15_000;

/** #48: the first pause between polls of the row while another replica refreshes; it doubles up to {@link LEASE_POLL_MAX_MS}. */
const LEASE_POLL_FIRST_MS = 50;
const LEASE_POLL_MAX_MS = 500;

/** A refresh skipped because the same grant failed moments ago (already logged). */
class RecentRefreshFailureError extends Error {
  constructor() {
    super('YNAB token refresh failed recently: not retrying yet');
    this.name = 'RecentRefreshFailureError';
  }
}

/** Another replica held the refresh lease for longer than the wait bound (#48). Not remembered as a failure. */
export class RefreshLeaseTimeoutError extends Error {
  constructor() {
    super('Another replica is refreshing the YNAB token: timed out waiting for it');
    this.name = 'RefreshLeaseTimeoutError';
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

/** Overrides of the refresh lease's timing (#48); tests use short values. */
export interface RefreshLeaseOptions {
  /** How long a claimed lease holds (default {@link REFRESH_LEASE_TTL_MS}). */
  leaseTtlMs?: number;
  /** How long a replica that lost the claim waits, in total (default {@link REFRESH_LEASE_WAIT_MS}). */
  leaseWaitMs?: number;
  /** The first pause between polls; doubles up to `pollMaxMs`. */
  pollFirstMs?: number;
  pollMaxMs?: number;
  /** The pause itself (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** The user row is gone (erased or never connected): the client must re-authorize. */
const RECONNECT = 'Unknown user: re-authorize the YNAB connection';

function generationOf(user: UserRecord): number {
  return user.createdAt ?? 0;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** A usable access token and its expiry. */
interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

export class YnabTokenResolver {
  // Keyed by user, and only valid for the account generation that minted it:
  // an erased account's token is never served to the account that replaced it.
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number; generation: number }>();
  // Refreshes in progress, per user. Concurrent requests join one refresh: YNAB
  // rotates the refresh token on every refresh, so a parallel second refresh
  // would present an already-used one and fail. The lease does the same across
  // replicas.
  private readonly refreshing = new Map<string, Promise<ResolvedUser>>();
  // Recent refresh failures, per user, keyed to the refresh token that failed:
  // a newly stored grant (a different token) is tried at once.
  private readonly failed = new Map<string, { encryptedRefreshToken: string; until: number }>();
  private readonly leaseTtlMs: number;
  private readonly leaseWaitMs: number;
  private readonly pollFirstMs: number;
  private readonly pollMaxMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly storage: Storage,
    private readonly encryptor: Encryptor,
    private readonly ynab: YnabOAuthConfig,
    private readonly now: () => number = Date.now,
    lease: RefreshLeaseOptions = {}
  ) {
    this.leaseTtlMs = lease.leaseTtlMs ?? REFRESH_LEASE_TTL_MS;
    this.leaseWaitMs = lease.leaseWaitMs ?? REFRESH_LEASE_WAIT_MS;
    this.pollFirstMs = lease.pollFirstMs ?? LEASE_POLL_FIRST_MS;
    this.pollMaxMs = lease.pollMaxMs ?? LEASE_POLL_MAX_MS;
    this.sleep = lease.sleep ?? defaultSleep;
  }

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

    // Another replica's refresh (#48), or this process's before a restart.
    const shared = this.sharedAccessToken(user);
    if (shared) return this.remember(user, shared);

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
   * A token function for a YnabClient: resolves the user's current YNAB
   * access token for each YNAB request. Failures become a YnabAuthError (a
   * fixed, mapped client message); the cause is logged sanitized. The account
   * generation is pinned, to `generation` when given (the one the /mcp
   * request resolved before its server was built), else to the one the first
   * call sees: if the account is erased and re-created meanwhile, later calls
   * fail instead of using the new account's grant.
   */
  accessTokenFor(userId: string, generation?: number): () => Promise<string> {
    let pinned: number | undefined = generation;
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

  /**
   * Drop this process's cached access token and remembered failure for a
   * user. The shared access token in the user's row (#48) is left alone: it
   * goes with the row, or with a re-consent, which clears it.
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
    this.failed.delete(userId);
  }

  /**
   * Get a fresh access token across replicas (#48): claim the user's refresh
   * lease and refresh under it, or, when another replica holds it, wait for
   * the access token it shares. Every step is one storage statement; nothing
   * is held between them.
   */
  private async refresh(start: UserRecord, retried = false): Promise<ResolvedUser> {
    const userId = start.userId;
    const generation = generationOf(start);
    // The wait bound counts from the first claim, not from the first sleep.
    const deadline = performance.now() + this.leaseWaitMs;
    let pause = this.pollFirstMs;
    for (;;) {
      const holder = randomUUID();
      const now = this.now();
      const claimed = await this.storage.claimRefreshLease(userId, holder, now, now + this.leaseTtlMs);
      if (claimed) {
        if (generationOf(claimed) !== generation) {
          await this.release(userId, holder);
          this.invalidate(userId);
          throw new Error(RECONNECT);
        }
        // Act on the row the claim returned, never on an older read: another
        // replica may have refreshed between that read and this claim.
        const shared = this.sharedAccessToken(claimed);
        if (shared) {
          await this.release(userId, holder);
          return this.remember(claimed, shared);
        }
        return this.refreshUnderLease(claimed, holder, retried);
      }

      // Another replica holds the lease (or the row is gone): wait for its token.
      const current = await this.storage.getUser(userId);
      if (!current || generationOf(current) !== generation) {
        this.invalidate(userId);
        throw new Error(RECONNECT);
      }
      const shared = this.sharedAccessToken(current);
      if (shared) return this.remember(current, shared);
      // Never a refresh of our own while the lease holds: fail closed instead.
      // Elapsed time (storage calls included), on a monotonic clock.
      const left = deadline - performance.now();
      if (left <= 0) throw new RefreshLeaseTimeoutError();
      await this.sleep(Math.min(pause, left));
      pause = Math.min(pause * 2, this.pollMaxMs);
    }
  }

  /**
   * Refresh against YNAB under the lease `holder` holds, from `user` (the row
   * the claim returned), and write the rotated refresh token and the shared
   * access token back with a compare-and-set, which also frees the lease. On
   * a miss the row is re-read: gone means the account was erased (reconnect
   * error, nothing written); changed means a newer token was stored, which
   * wins: another replica's refresh (this lease ran out) shares its access
   * token; a re-consent is refreshed from once, or refused if the account was
   * re-created.
   */
  private async refreshUnderLease(user: UserRecord, holder: string, retried: boolean): Promise<ResolvedUser> {
    const userId = user.userId;
    const context = refreshTokenContext(userId);
    let set: YnabTokenSet;
    let refreshToken: string;
    try {
      refreshToken = this.encryptor.decrypt(user.encryptedRefreshToken, context);
      set = await refreshAccessToken(this.ynab, refreshToken);
    } catch (error) {
      await this.release(userId, holder);
      // A slow call may have outlived the lease, and another replica refreshed meanwhile.
      const current = await this.storage.getUser(userId).catch(() => undefined);
      const shared =
        current && generationOf(current) === generationOf(user) ? this.sharedAccessToken(current) : undefined;
      if (current && shared) return this.remember(current, shared);
      this.failed.set(userId, {
        encryptedRefreshToken: user.encryptedRefreshToken,
        until: this.now() + REFRESH_FAILURE_TTL_MS,
      });
      throw error;
    }
    this.failed.delete(userId);

    // YNAB rotates the refresh token on every refresh — persist the new one,
    // but only over the token this refresh started from, with the access token
    // the other replicas will use.
    const newCiphertext = this.encryptor.encrypt(set.refreshToken, context);
    const refreshed = {
      encryptedAccessToken: this.encryptor.encrypt(set.accessToken, accessTokenContext(userId)),
      expiresAt: set.expiresAt,
      now: this.now(),
    };
    let stored = await this.storage.updateUserRefreshToken(
      userId,
      user.encryptedRefreshToken,
      newCiphertext,
      refreshed
    );
    if (!stored) {
      let current = await this.storage.getUser(userId);
      // The rekey job (#57b) moved the same YNAB token to the current key
      // meanwhile: that token is spent now, so write over its new ciphertext
      // instead of refreshing again from it.
      if (current && generationOf(current) === generationOf(user) && this.holdsToken(current, refreshToken)) {
        stored = await this.storage.updateUserRefreshToken(
          userId,
          current.encryptedRefreshToken,
          newCiphertext,
          refreshed
        );
        if (!stored) current = await this.storage.getUser(userId);
      }
      if (!stored) {
        await this.release(userId, holder);
        if (!current || generationOf(current) !== generationOf(user)) {
          this.invalidate(userId);
          throw new Error(RECONNECT);
        }
        const shared = this.sharedAccessToken(current);
        if (shared) return this.remember(current, shared);
        if (retried) {
          this.invalidate(userId);
          throw new Error(RECONNECT);
        }
        return this.refresh(current, true);
      }
    }
    // The access level as stored now, not as read before the YNAB call: a
    // re-consent that lowered it meanwhile (same YNAB token) applies at once.
    return this.remember(stored, set);
  }

  /** Cache `token` for `user`'s generation and return it with the access level as stored. */
  private remember(user: UserRecord, token: AccessToken): ResolvedUser {
    const generation = generationOf(user);
    this.cache.set(user.userId, { accessToken: token.accessToken, expiresAt: token.expiresAt, generation });
    return { accessToken: token.accessToken, grantedScope: user.grantedScope, generation };
  }

  /**
   * The shared access token in `user`'s row (#48), when it is fresh and opens
   * under its own context. Anything else (none, expiring, a `v1` value, not
   * bound to this user and column, a retired or unknown key) counts as
   * absent: a refresh replaces it.
   */
  private sharedAccessToken(user: UserRecord): AccessToken | undefined {
    const ciphertext = user.encryptedAccessToken;
    const expiresAt = user.accessTokenExpiresAt;
    if (ciphertext === undefined || expiresAt === undefined || expiresAt <= this.now() + REFRESH_SKEW_MS) {
      return undefined;
    }
    if (ciphertextVersion(ciphertext)?.format !== 'v2') return undefined;
    try {
      return { accessToken: this.encryptor.decrypt(ciphertext, accessTokenContext(user.userId)), expiresAt };
    } catch {
      return undefined;
    }
  }

  /** Free the lease `holder` holds; a failure is left to the lease's expiry. */
  private async release(userId: string, holder: string): Promise<void> {
    await this.storage.releaseRefreshLease(userId, holder).catch(() => undefined);
  }

  /** Whether `user`'s stored ciphertext (possibly re-encrypted) holds `refreshToken`. */
  private holdsToken(user: UserRecord, refreshToken: string): boolean {
    try {
      return this.encryptor.decrypt(user.encryptedRefreshToken, refreshTokenContext(user.userId)) === refreshToken;
    } catch {
      return false;
    }
  }
}
