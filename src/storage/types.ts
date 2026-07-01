/**
 * Persistence interface for the multi-tenant OAuth server.
 *
 * Holds: users (identified by their YNAB user id), each user's encrypted YNAB
 * refresh token + granted scope, dynamically-registered MCP clients, short-lived
 * MCP authorization codes, MCP access/refresh tokens, and the short-lived
 * "pending authorization" records that bridge the MCP-authorize and YNAB-callback
 * legs of the federated flow.
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
}

export interface AccessTokenRecord {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  userId: string;
  scopes: string[];
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

  // MCP refresh tokens, one-time (rotated on use)
  saveRefreshToken(rec: RefreshTokenRecord): Promise<void>;
  takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;
  deleteRefreshToken(token: string): Promise<void>;
}
