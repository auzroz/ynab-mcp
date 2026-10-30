/**
 * Persistence interface for the multi-tenant OAuth server.
 *
 * Holds: users (identified by their YNAB user id), each user's encrypted YNAB
 * refresh token + granted scope, dynamically-registered MCP clients, short-lived
 * MCP authorization codes, MCP access/refresh tokens, tombstones of rotated
 * refresh tokens (for reuse detection), and the short-lived "pending
 * authorization" records that bridge the MCP-authorize and YNAB-callback legs of
 * the federated flow.
 *
 * All secrets (YNAB refresh tokens) are stored already-encrypted by the caller.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export type GrantedScope = 'read-only' | 'read-write';

export interface UserRecord {
  /** YNAB user id — the identity in this system. */
  userId: string;
  grantedScope: GrantedScope;
  /** AES-GCM-encrypted YNAB refresh token. */
  encryptedRefreshToken: string;
  updatedAt: number;
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

export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  // Users + YNAB tokens
  upsertUser(rec: UserRecord): Promise<void>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  deleteUser(userId: string): Promise<void>;

  // MCP clients (Dynamic Client Registration)
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;

  // Pending federated authorization (state -> record), one-time
  savePendingAuth(rec: PendingAuthRecord): Promise<void>;
  takePendingAuth(state: string): Promise<PendingAuthRecord | undefined>;

  // MCP authorization codes, one-time
  saveAuthCode(rec: AuthCodeRecord): Promise<void>;
  takeAuthCode(code: string): Promise<AuthCodeRecord | undefined>;

  // MCP access tokens
  saveAccessToken(rec: AccessTokenRecord): Promise<void>;
  getAccessToken(token: string): Promise<AccessTokenRecord | undefined>;
  deleteAccessToken(token: string): Promise<void>;

  // MCP refresh tokens, one-time (rotated on use). getRefreshToken only looks
  // a token up (to validate a request before spending it); takeRefreshToken is
  // the atomic one-time use.
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
   * written) when the token was not live.
   */
  rotateRefreshToken(token: string, rotation: RefreshTokenRotation): Promise<RefreshTokenRecord | undefined>;

  // Consumed refresh tokens (reuse detection). Undefined once expired.
  getConsumedRefreshToken(token: string): Promise<ConsumedRefreshTokenRecord | undefined>;

  /** Delete every access and refresh token of a grant family, atomically. */
  deleteTokenFamily(familyId: string): Promise<void>;
}
