/**
 * Persistence interface for the multi-tenant OAuth server.
 *
 * Holds: users (identified by their YNAB user id), each user's encrypted YNAB
 * refresh token + granted scope, dynamically-registered MCP clients, short-lived
 * MCP authorization codes, MCP access/refresh tokens, tombstones of rotated
 * refresh tokens and of spent authorization codes (for reuse and replay
 * detection), and the short-lived "pending authorization" records that bridge
 * the MCP-authorize and YNAB-callback legs of the federated flow.
 *
 * All secrets (YNAB refresh tokens) are stored already-encrypted by the caller.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { RetentionPolicy } from '../auth/retention-defaults.js';

export type GrantedScope = 'read-only' | 'read-write';

export interface UserRecord {
  /** YNAB user id — the identity in this system. */
  userId: string;
  grantedScope: GrantedScope;
  /** AES-GCM-encrypted YNAB refresh token. */
  encryptedRefreshToken: string;
  updatedAt: number;
  /**
   * When this user row was inserted (storage clock, epoch ms): the account's
   * generation. Read-only: {@link Storage.upsertUser} sets it on insert and
   * ignores it otherwise. Undefined for users created before 0.5.0, which
   * count as generation 0. Tokens issued before it belong to an erased
   * account and are never valid (see {@link Storage.getAccessToken}).
   */
  createdAt?: number | undefined;
}

export interface AuthCodeRecord {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
  /**
   * Canonical RFC 8707 resource this record is bound to. Undefined for rows
   * written by 0.3.x (and, for pending auth / codes, when the client sent no
   * `resource`); the provider treats those as bound to the configured resource.
   */
  resource?: string | undefined;
  /**
   * Access level the user chose at consent for this grant. Undefined for rows
   * written before 0.4.0; the provider treats those as read-only.
   */
  grantedScope?: GrantedScope | undefined;
}

export interface AccessTokenRecord {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
  /**
   * Canonical RFC 8707 resource this record is bound to. Undefined for rows
   * written by 0.3.x (and, for pending auth / codes, when the client sent no
   * `resource`); the provider treats those as bound to the configured resource.
   */
  resource?: string | undefined;
  /**
   * Access level the user chose at consent for this grant. Undefined for rows
   * written before 0.4.0; the provider treats those as read-only.
   */
  grantedScope?: GrantedScope | undefined;
  /**
   * Grant family (RFC 9700 section 4.14.2): one id per authorization-code
   * exchange, carried by every token issued from that code and from refreshes
   * in its chain. Undefined for rows written before 0.4.0.
   */
  familyId?: string | undefined;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
  /**
   * Canonical RFC 8707 resource this record is bound to. Undefined for rows
   * written by 0.3.x (and, for pending auth / codes, when the client sent no
   * `resource`); the provider treats those as bound to the configured resource.
   */
  resource?: string | undefined;
  /**
   * Access level the user chose at consent for this grant. Undefined for rows
   * written before 0.4.0; the provider treats those as read-only.
   */
  grantedScope?: GrantedScope | undefined;
  /**
   * Grant family (RFC 9700 section 4.14.2): one id per authorization-code
   * exchange, carried by every token issued from that code and from refreshes
   * in its chain. Undefined for rows written before 0.4.0.
   */
  familyId?: string | undefined;
}

/**
 * Tombstone of a refresh token that was spent by rotation, kept until
 * `expiresAt` so a later replay of it can be recognized as reuse.
 */
export interface ConsumedRefreshTokenRecord {
  token: string;
  clientId: string;
  /** The family the token's replay revokes. */
  familyId: string;
  expiresAt: number;
}

/** What {@link Storage.rotateRefreshToken} writes when it spends a refresh token. */
export interface RefreshTokenRotation {
  /** Family the spent token's tombstone points at (that of the new tokens). */
  familyId: string;
  /** When the spent token's tombstone expires. */
  consumedUntil: number;
  /** The token pair issued in its place. */
  accessToken: AccessTokenRecord;
  refreshToken: RefreshTokenRecord;
}

/**
 * Tombstone of an authorization code spent at the token endpoint, kept until
 * `expiresAt` so a second use of the code can be recognized as a replay
 * (RFC 9700 section 4.2.4, RFC 6749 section 4.1.2). Written in the same
 * atomic step that spends the code, with the token family the code's tokens
 * will join, before those tokens exist. Keyed by the plaintext code until codes are hashed at rest.
 */
export interface ConsumedAuthCodeRecord {
  code: string;
  clientId: string;
  userId: string | undefined;
  /** The family the code's tokens join, and that a replay of the code revokes. */
  familyId: string;
  expiresAt: number;
  /**
   * Set once a replay has revoked the family. Tokens are never saved for a
   * revoked code, so a replay that lands between the code being spent and its
   * tokens being saved leaves no live token.
   */
  revoked: boolean;
}

/** What {@link Storage.consumeAuthCode} records when it spends a code. */
export interface AuthCodeConsumption {
  /** The pre-allocated family of the tokens the code will be exchanged for. */
  familyId: string;
  /** When the code's tombstone expires. */
  consumedUntil: number;
}

/** The token pair issued for a spent authorization code ({@link Storage.saveCodeTokens}). */
export interface CodeTokens {
  /** Must be the family recorded on the code's tombstone. */
  familyId: string;
  accessToken: AccessTokenRecord;
  refreshToken: RefreshTokenRecord;
}

/** Bridges the MCP `/authorize` leg to the YNAB `/oauth/ynab/callback` leg. */
export interface PendingAuthRecord {
  /** Opaque state we send to YNAB and expect back. */
  state: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The MCP client's own `state`, echoed back to it at the end. */
  clientState: string | undefined;
  /** Scopes the MCP client requested. */
  scopes: string[];
  /** The YNAB scope chosen at consent ("read-only" or full). */
  grantedScope: GrantedScope;
  expiresAt: number;
  /**
   * Canonical RFC 8707 resource this record is bound to. Undefined for rows
   * written by 0.3.x (and, for pending auth / codes, when the client sent no
   * `resource`); the provider treats those as bound to the configured resource.
   */
  resource?: string | undefined;
  /**
   * SHA-256 (base64url) of the consent-cookie nonce set when the consent page
   * was shown; the federation legs require the matching cookie. Undefined for
   * rows written before 0.4.0, which are therefore never usable.
   */
  browserBinding?: string | undefined;
}

/** One live grant (token family) of a user, as {@link Storage.listConnections} reports it. */
export interface ConnectionRecord {
  familyId: string;
  clientId: string;
  /** The client's self-declared `client_name`, unsanitized; undefined if none or the client is gone. */
  clientName: string | undefined;
  /** The access level of the grant; read-only for grants written before 0.4.0. */
  grantedScope: GrantedScope;
  /**
   * When the grant's code was exchanged (epoch ms); the upgrade instant for
   * older grants. Undefined only for a row a 0.4.x replica wrote since the
   * last startup (the next startup's backfill stamps it).
   */
  createdAt: number | undefined;
  /** When its current refresh token was issued: the last refresh, or the exchange. */
  lastUsedAt: number | undefined;
  /** When it expires unless refreshed first (the idle limit, capped by the absolute one). */
  expiresAt: number | undefined;
}

/** Rows removed by one {@link Storage.sweepExpired} run, per rule. */
export interface SweepCounts {
  pendingAuth: number;
  authCodes: number;
  accessTokens: number;
  /** Refresh tokens past their idle or absolute limit. */
  refreshTokens: number;
  consumedRefreshTokens: number;
  consumedAuthCodes: number;
  /** Access and refresh tokens whose user row is gone or newer than they are. */
  orphanTokens: number;
  /** Clients that never completed an authorization (abandoned registrations). */
  abandonedClients: number;
  /** Clients with no live grant since their last authorization window. */
  unusedClients: number;
}

export interface SweepResult {
  /** False when another sweeper held the sweep lock (Postgres); nothing was deleted. */
  ran: boolean;
  deleted: SweepCounts;
}

export interface SweepOptions {
  /** The sweep's clock (epoch ms); defaults to the storage clock. */
  now?: number;
  /** Rows per DELETE statement. */
  batchSize?: number;
}

/** Options every driver accepts. */
export interface StorageDriverOptions {
  /** Retention windows; the defaults are in `src/auth/retention-defaults.ts`. */
  retention?: Partial<RetentionPolicy> | undefined;
}

/**
 * What the account tools (#53b) may do to a user's data: only ever the
 * authenticated user's own rows. The provider-internal, unscoped
 * {@link Storage.deleteTokenFamily} is deliberately not here. Build one with
 * `createAccountStore` (src/storage/account-store.ts).
 */
export interface AccountStore {
  listConnections(userId: string): Promise<ConnectionRecord[]>;
  revokeUserFamily(userId: string, familyId: string): Promise<boolean>;
  deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number>;
  deleteUserData(userId: string): Promise<void>;
}

export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  // Users + YNAB tokens
  /**
   * Insert or update a user. Only the insert sets `created_at` (from the
   * storage clock); an update keeps it, whatever `rec.createdAt` says. Used at
   * consent; the YNAB refresh write-back uses {@link updateUserRefreshToken}.
   */
  upsertUser(rec: UserRecord): Promise<void>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  /**
   * Compare-and-set the user's YNAB refresh token: replace it with
   * `newCiphertext` (and stamp `updated_at`) only while the stored value is
   * still `oldCiphertext`. Never inserts, so a refresh that finishes after the
   * user was deleted can't bring the row back, and writes no other column, so
   * a re-consent that changed the access level meanwhile keeps it. Returns the
   * row as written (read the access level from it, not from the record the
   * refresh started with), or undefined (nothing written) when the row is gone
   * or holds another token.
   */
  updateUserRefreshToken(
    userId: string,
    oldCiphertext: string,
    newCiphertext: string
  ): Promise<UserRecord | undefined>;
  /** Deletes the `users` row only. To erase an account, use {@link deleteUserData}. */
  deleteUser(userId: string): Promise<void>;
  /**
   * Erase everything stored for a user, atomically: the user row, auth codes,
   * code tombstones, access and refresh tokens, and the refresh-token
   * tombstones of the user's families. On Postgres the user's family locks are
   * taken first, in sorted order. A token minted concurrently by a refresh or
   * a code exchange either is deleted here or is refused (it predates the
   * account's next generation).
   */
  deleteUserData(userId: string): Promise<void>;

  // Account self-service (#53b), reached by tools only through AccountStore.
  /** The user's live grants, one per token family, oldest first. */
  listConnections(userId: string): Promise<ConnectionRecord[]>;
  /**
   * Revoke one of the user's grants: its tokens, and its code tombstone (so an
   * exchange in flight is refused). Scoped by `userId`: another user's or an
   * unknown family is a no-op. Returns whether a token was deleted.
   */
  revokeUserFamily(userId: string, familyId: string): Promise<boolean>;
  /** Revoke every grant the user gave `clientId`. Returns the number of families revoked. */
  deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number>;

  /**
   * Delete expired and dead rows in batches: pending auth, codes, access tokens
   * and tombstones past `expires_at`; refresh tokens past the idle or absolute
   * limit; tokens of erased users; abandoned and unused client registrations.
   * On Postgres it holds a session advisory try-lock, so of two concurrent
   * sweepers one runs and the other returns `ran: false`.
   */
  sweepExpired(options?: SweepOptions): Promise<SweepResult>;

  // MCP clients (Dynamic Client Registration). saveClient stamps created_at on insert.
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;

  // Pending federated authorization (state -> record), one-time
  savePendingAuth(rec: PendingAuthRecord): Promise<void>;
  takePendingAuth(state: string): Promise<PendingAuthRecord | undefined>;

  // MCP authorization codes, one-time. takeAuthCode is a bare atomic take for
  // tests and maintenance: it leaves no tombstone, so the token endpoint must
  // spend codes only through consumeAuthCode, or replay detection is bypassed.
  saveAuthCode(rec: AuthCodeRecord): Promise<void>;
  takeAuthCode(code: string): Promise<AuthCodeRecord | undefined>;
  /**
   * The atomic one-time use of a code at the token endpoint: take `code` and,
   * only if it was live (present and unexpired), record its tombstone with the
   * taken row's client and user and `consumption.familyId`, in one atomic step.
   * So whoever finds the code gone after this also finds its tombstone. Also
   * prunes expired tombstones. Returns the live row taken, or undefined
   * (nothing recorded) when the code was unknown, already spent or expired.
   */
  consumeAuthCode(code: string, consumption: AuthCodeConsumption): Promise<AuthCodeRecord | undefined>;
  /** A spent code's tombstone; undefined when there is none or it has expired. */
  getConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined>;
  /**
   * Handle a replay of a spent code: mark its live tombstone revoked and delete
   * every access and refresh token of its family, atomically and under the
   * family's lock (so a {@link saveCodeTokens} in flight either commits first
   * and is deleted, or runs after and is refused). Returns the tombstone, now
   * revoked, or undefined (nothing changed) when there is no live tombstone.
   */
  revokeConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined>;
  /**
   * Save the token pair issued for a spent code, but only while its tombstone
   * is live, not revoked, and names `tokens.familyId`, and the user row
   * exists; checked and written atomically under the family's lock (on
   * Postgres the user row is also held FOR KEY SHARE, as in rotation). Returns
   * false (nothing written) otherwise. Starts the family's absolute clock and
   * stamps the client's `last_authorized_at`.
   */
  saveCodeTokens(code: string, tokens: CodeTokens): Promise<boolean>;

  // MCP access and refresh tokens. Every insert stamps `issued_at` from the
  // storage clock. Every read is joined to the token's user: a token whose
  // user row is gone, or was issued before that row was created (an erased
  // account that signed up again), reads as unknown.
  saveAccessToken(rec: AccessTokenRecord): Promise<void>;
  getAccessToken(token: string): Promise<AccessTokenRecord | undefined>;
  deleteAccessToken(token: string): Promise<void>;

  // MCP refresh tokens, one-time (rotated on use). getRefreshToken only looks
  // a token up (to validate a request before spending it). takeRefreshToken is
  // a bare atomic take for tests and maintenance: it leaves no tombstone and
  // takes no family lock, so a refresh grant must spend tokens only through
  // rotateRefreshToken, or reuse detection is bypassed. A refresh token past
  // its idle or absolute limit (RetentionPolicy) reads as unknown and is
  // deleted on that read; its family is left alone.
  saveRefreshToken(rec: RefreshTokenRecord): Promise<void>;
  getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;
  takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;
  deleteRefreshToken(token: string): Promise<void>;
  /**
   * The atomic one-time use as a rotation: take `token` and, only if it was
   * live, record its tombstone (with the taken row's client id) and save the new
   * token pair, all in one atomic step. So whoever finds the token gone after a
   * rotation also finds its tombstone and the tokens issued in its place. Also
   * prunes expired tombstones. Returns the taken row, or undefined (nothing
   * written) when the token was not live. Not live includes: past its idle or
   * absolute limit (the token is then deleted with no tombstone), and its user
   * row gone or newer than the token. The new refresh token keeps the family's
   * creation time, and on Postgres the user row is held (FOR KEY SHARE) so a
   * concurrent {@link deleteUserData} either waits for the new pair or wins.
   */
  rotateRefreshToken(token: string, rotation: RefreshTokenRotation): Promise<RefreshTokenRecord | undefined>;

  // Consumed refresh tokens (reuse detection). Undefined once expired.
  getConsumedRefreshToken(token: string): Promise<ConsumedRefreshTokenRecord | undefined>;

  /** Delete every access and refresh token of a grant family, atomically. */
  deleteTokenFamily(familyId: string): Promise<void>;
}
