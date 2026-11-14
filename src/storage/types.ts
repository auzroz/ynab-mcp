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
 * Tokens, codes and pending-auth state are stored and looked up by the keys
 * the caller derives from them (`h1.` keys, src/auth/token-hash.ts), never by
 * the values clients hold; to storage a key is an opaque string. DCR client
 * secrets are stored as `client_secret_hash` (`s256.`) inside the client JSON.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type { RetentionPolicy } from '../auth/retention-defaults.js';
import type { StorageTimeouts } from './timeouts.js';

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
 * will join, before those tokens exist. Keyed by the code's storage key, like the code itself.
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
  // oidc-provider rows (`oauth_rows`, ADR-0002 D4). The counters above are the 0.4.x tables'.
  /** Expired rows that were never consumed: tokens, codes, sessions, interactions, staged sign-ins. */
  oauthExpired: number;
  /** Consumed codes and refresh tokens past their retention (D6) whose grant has no live token. */
  oauthConsumed: number;
  /** Grant-bound rows whose grant or user is gone (or newer), and registration tokens of removed clients. */
  oauthOrphans: number;
  /** Expired grants with no row left under them. */
  oauthGrants: number;
  /** Library clients that never completed a sign-in, past the abandoned-registration window. */
  oauthAbandonedClients: number;
  /** Library clients with nothing in flight and no sign-in within the unused-client window. */
  oauthUnusedClients: number;
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

/**
 * Checks one client's metadata against oidc-provider's client schema (M4,
 * ADR-0002 D12). Resolves to undefined when the client is valid, otherwise to
 * a short reason that names no value from the metadata. The default is
 * `createClientSchemaValidator` in src/auth/oidc/client-schema.ts.
 */
export type ClientSchemaValidator = (metadata: Readonly<Record<string, unknown>>) => Promise<string | undefined>;

/** Options every driver accepts. */
export interface StorageDriverOptions {
  /** Retention windows; the defaults are in `src/auth/retention-defaults.ts`. */
  retention?: Partial<RetentionPolicy> | undefined;
  /** Overrides for the storage time bounds (defaults in `./timeouts.ts`); tests use short values. */
  timeouts?: Partial<StorageTimeouts> | undefined;
  /**
   * The client schema M4 converts registered clients against. Defaults to
   * the library's own (loaded only when a client is waiting for conversion);
   * tests may pass another. Memory storage has nothing to convert.
   */
  clientSchema?: ClientSchemaValidator | undefined;
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

export interface Storage extends OAuthRowStore {
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
   *
   * The oidc-provider rows go in the same step (ADR-0002 D4, D12): every
   * `oauth_rows` row with the user's `account_id`, and every row of the user's
   * grants. The 0.4.x token tables above are cleared too, although nothing
   * reads them after the cut-over. (SQLite and Postgres: #47-1's driver step.)
   */
  deleteUserData(userId: string): Promise<void>;

  // Account self-service (#53b), reached by tools only through AccountStore.
  // Both generations until the cut-over (#47-4): a 0.4.x token family and an
  // oidc-provider grant are each one connection, and a grant id is accepted
  // wherever a family id is (ADR-0002 D4: `revokeUserFamily` takes a grant id).
  /**
   * The user's live grants, oldest first: one per 0.4.x token family with a
   * live refresh token, and one per oidc-provider grant with a live access or
   * refresh token issued under the user's current row.
   */
  listConnections(userId: string): Promise<ConnectionRecord[]>;
  /**
   * Revoke one of the user's grants: a 0.4.x family's tokens and its code
   * tombstone (so an exchange in flight is refused), or an oidc-provider grant
   * with every row under it. Scoped by `userId`: another user's or an unknown
   * id is a no-op. Returns whether anything was revoked.
   */
  revokeUserFamily(userId: string, familyId: string): Promise<boolean>;
  /**
   * Revoke every grant the user gave `clientId`, in both generations.
   * Returns the number of families and grants revoked.
   */
  deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number>;

  /**
   * Delete expired and dead rows in batches: pending auth, codes, access tokens
   * and tombstones past `expires_at`; refresh tokens past the idle or absolute
   * limit; tokens of erased users; abandoned and unused client registrations.
   * On Postgres it holds a session advisory try-lock, so of two concurrent
   * sweepers one runs and the other returns `ran: false`.
   *
   * The same for `oauth_rows` (ADR-0002 D4, D6; the rules are in
   * src/storage/retention.ts): expired rows never consumed; consumed codes
   * and refresh tokens once `CONSUMED_CREDENTIAL_RETENTION_MS` (30 days) has passed
   * and their grant has no live token; grant-bound rows whose grant or user is
   * gone; expired grants with nothing under them; and library clients by the
   * same abandoned and unused windows, on `created_at` and `authorized_at`.
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
  /**
   * Finish an OAuth sign-in in one transaction: check that `code.clientId` is
   * still registered, upsert `user` (as {@link Storage.upsertUser}), and insert
   * `code` (as {@link Storage.saveAuthCode}). Returns false, having written
   * nothing, when the client is gone (the cleanup sweep removed it), so a
   * failed sign-in changes no stored grant. A write that fails throws and
   * leaves nothing behind either. On Postgres the client row is updated
   * (`last_seen_at`), not only read, so a sweep racing the transaction either
   * skips the client or deletes it first and completes the sign-in as false.
   */
  completeAuthorization(input: { user: UserRecord; code: AuthCodeRecord }): Promise<boolean>;
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

// ---------------------------------------------------------------------------
// oidc-provider storage (ADR-0002 D4): one `oauth_rows` table behind the
// library's adapter (src/auth/oidc/adapter.ts). The adapter derives every key
// and the stored payload; a driver stores both as opaque strings and enforces
// the rules below atomically. Memory implements it in #47-1; SQLite and
// Postgres implement it in #47-1's driver step, against
// tests/unit/storage/oauth-adapter-conformance.test.ts.
// ---------------------------------------------------------------------------

/**
 * What a row holds: the oidc-provider models the adapter stores, plus
 * `SignIn`, the sign-in `complete` stages under its grant until the code's
 * upsert applies it (#94, D4).
 */
export type OAuthModel =
  | 'AccessToken'
  | 'RefreshToken'
  | 'AuthorizationCode'
  | 'RegistrationAccessToken'
  | 'Session'
  | 'Interaction'
  | 'Grant'
  | 'Client'
  | 'SignIn';

/** One `oauth_rows` row as the adapter writes it. */
export interface OAuthRowWrite {
  /**
   * The primary key: `h1.` + HMAC of the row's kind and id for every model
   * whose id is a credential (tokens, codes, sessions, interactions,
   * registration tokens), `Grant:<id>`, `Client:<id>` or `SignIn:<grant id>`
   * for the others (src/storage/oauth-rows.ts).
   */
  key: string;
  model: OAuthModel;
  /**
   * The library's payload as JSON text, without `jti` (the credential itself)
   * or `consumed` (kept in `consumedAt`), and with a client's secret replaced
   * by its `s256.` hash.
   */
  payload: string;
  /** The grant the row belongs to (the grant's own id on its `Grant` row). */
  grantId: string | undefined;
  /** The YNAB user id (the library's `accountId`). */
  accountId: string | undefined;
  /** The client the row belongs to (its own id on a `Client` row). */
  clientId: string | undefined;
  /** A session's `uid`, for `findByUid`. */
  uid: string | undefined;
  /** Epoch ms (storage clock); undefined for rows without a lifetime (clients). */
  expiresAt: number | undefined;
}

/** One `oauth_rows` row as storage returns it. */
export interface OAuthRowRecord extends OAuthRowWrite {
  /** When a code or refresh token was consumed (epoch ms, storage clock); undefined while live. */
  consumedAt: number | undefined;
  /** When the row was inserted (storage clock); an update keeps it. STOR-1's generation check reads it. */
  createdAt: number;
  /**
   * `Client` rows only: when a sign-in for the client last completed (its
   * code was issued), or when M4 converted it. Undefined until then. The
   * client sweep's clock.
   */
  authorizedAt: number | undefined;
}

/** The sign-in `complete` stages under its grant (#94, D4). */
export interface StagedSignIn {
  grantId: string;
  /** The user the code's upsert applies, as {@link Storage.upsertUser} would. */
  user: UserRecord;
  /** Epoch ms: the interaction's lifetime. */
  expiresAt: number;
}

/**
 * What {@link OAuthRowStore.saveAuthorizationCode} did. Anything but `saved`
 * wrote nothing.
 */
export type CodeSaveOutcome = 'saved' | 'client-gone' | 'grant-gone' | 'no-sign-in';

/**
 * What {@link OAuthRowStore.consumeOAuthRow} did: `consumed` (this call set
 * `consumed_at`), `replayed` (it was already consumed, so its grant was
 * revoked in the same step) or `missing` (no such row; nothing changed).
 */
export type ConsumeOutcome = 'consumed' | 'replayed' | 'missing';

/**
 * The driver-facing contract behind the oidc-provider adapter. Every method
 * is atomic. "Grant-bound" rows are AccessToken, RefreshToken and
 * AuthorizationCode.
 */
export interface OAuthRowStore {
  /**
   * Insert or update a row that isn't grant-bound or staged (Client, Grant,
   * Session, Interaction, RegistrationAccessToken). An update replaces the
   * payload and the indexed columns and keeps `createdAt`, `consumedAt` and
   * `authorizedAt`. Throws for a grant-bound or `SignIn` row.
   */
  upsertOAuthRow(row: OAuthRowWrite): Promise<void>;
  /**
   * Save an AccessToken or RefreshToken, only while its grant row exists for
   * the same account and client and the account's user row exists, checked
   * and written in one transaction (on Postgres under the grant's lock, with
   * the user row held FOR KEY SHARE). Returns false, having written nothing,
   * otherwise: a revocation that ran first leaves nothing behind (#42).
   */
  saveGrantToken(row: OAuthRowWrite): Promise<boolean>;
  /**
   * Save an AuthorizationCode with #94's `completeAuthorization` semantics, in
   * one transaction: the client row must exist (and is stamped
   * `authorizedAt`, which also locks it against the sweep), the grant row must
   * exist for the same account and client, and the grant's staged sign-in
   * must be live for the same account. Then the staged user is applied (as
   * {@link Storage.upsertUser}, `created_at` from the same clock instant as
   * the code's `createdAt`), the staged row is deleted and the code is
   * inserted. Anything else writes nothing.
   *
   * One code per staged sign-in: the sign-in is spent with its code. D2 allows
   * no silent sign-in (`loadExistingGrant` returns only the grant the current
   * interaction created), so every code follows its own interaction, which
   * stages its own sign-in under a new grant. A second code for one grant is
   * refused (`no-sign-in`, answered as `server_error`): it fails closed.
   */
  saveAuthorizationCode(row: OAuthRowWrite): Promise<CodeSaveOutcome>;
  /**
   * Stage a sign-in under its grant (replacing an earlier one), only while the
   * grant row exists for `user.userId`. Returns false (nothing written) otherwise.
   */
  stageSignIn(signIn: StagedSignIn): Promise<boolean>;
  /**
   * The row under `key`, whatever its age (the adapter applies expiry). A
   * grant-bound row is returned only while its grant row exists and its user
   * row exists and is not newer than the row (STOR-1's issued-under-user
   * rule, on `createdAt`); otherwise it reads as unknown.
   */
  findOAuthRow(key: string): Promise<OAuthRowRecord | undefined>;
  /** The newest `Session` row with this `uid`. */
  findOAuthRowByUid(uid: string): Promise<OAuthRowRecord | undefined>;
  /**
   * Compare-and-set consumption of a code or refresh token: set `consumedAt`
   * only while it is unset. When it was already set, revoke the row's whole
   * grant ({@link revokeOAuthGrant}) in the same transaction. Throws for a row
   * of another model.
   */
  consumeOAuthRow(key: string): Promise<ConsumeOutcome>;
  /** Delete one row (not a grant's: use {@link revokeOAuthGrant}). */
  destroyOAuthRow(key: string): Promise<void>;
  /**
   * Delete every row of a grant, live or consumed, its `Grant` row included,
   * so a token save racing the revocation is refused. The adapter uses it for
   * the library's `revokeByGrantId` and for destroying a grant. Returns the
   * rows deleted.
   */
  revokeOAuthGrant(grantId: string): Promise<number>;
}
