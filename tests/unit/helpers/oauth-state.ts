/**
 * Plants OAuth state (clients, users, codes, access tokens) for the HTTP tests.
 *
 * The tests need a connected user, a registered client, an access token the
 * `/mcp` bearer check accepts, or a code the token endpoint can redeem, without
 * running the whole sign-in each time. They used to write those rows straight
 * to storage with the authorization server's record shapes. Everything that
 * depends on how the current server stores them lives here instead, so
 * replacing the authorization server (#47-4) changes this file, not the tests.
 *
 * Each plant function returns what a client would hold: the bearer value or the
 * code, never the storage key.
 */

import type { Express } from 'express';
import request from 'supertest';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type { Storage, UserRecord } from '../../../src/storage/types.js';
import { TEST_TOKEN_HASHER } from './token-hasher.js';

type GrantedScope = NonNullable<UserRecord['grantedScope']>;

/** An `Authorization` header value carrying `accessToken` as a bearer token. */
export function bearerHeader(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

/** Stores a connected user (the YNAB grant a token or code resolves to). */
export async function plantUser(
  storage: Storage,
  user: { userId: string; grantedScope: GrantedScope; encryptedRefreshToken: string }
): Promise<void> {
  await storage.upsertUser({ ...user, updatedAt: Date.now() });
}

/**
 * Stores an access token as the authorization server issues one and returns the
 * bearer value. `clientId`, `userId`, `scopes`, `expiresAt` (epoch ms) and
 * `resource` are the token's claims; `grantedScope` is the grant level it records.
 */
export async function plantAccessToken(
  storage: Storage,
  token: {
    clientId: string;
    userId: string;
    scopes: string[];
    expiresAt: number;
    resource: string;
    grantedScope: GrantedScope;
  }
): Promise<string> {
  const { value, key } = TEST_TOKEN_HASHER.issue('access');
  await storage.saveAccessToken({ token: key, ...token });
  return value;
}

/**
 * The value of a well-formed access token that was never stored, so the bearer
 * check refuses it as unknown.
 */
export function unknownAccessToken(): string {
  return TEST_TOKEN_HASHER.issue('access').value;
}

/** Deletes the stored access token whose bearer value is `accessToken`. */
export async function revokePlantedAccessToken(storage: Storage, accessToken: string): Promise<void> {
  await storage.deleteAccessToken(TEST_TOKEN_HASHER.keyFor('access', accessToken) as string);
}

/**
 * Stores an authorization code as the authorization server issues one and
 * returns the value a client redeems at `/token`. A code is only redeemable
 * while its user is connected, so tests that redeem it also call
 * {@link plantUser}. `grantedScope` is left off when not given.
 */
export async function plantAuthCode(
  storage: Storage,
  code: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    expiresAt: number;
    grantedScope?: GrantedScope;
  }
): Promise<string> {
  const { value, key } = TEST_TOKEN_HASHER.issue('code');
  await storage.saveAuthCode({ code: key, ...code });
  return value;
}

/** The storage key `plantAuthCode` stored `code` under, to look the row up directly. */
export function authCodeKey(code: string): string {
  return TEST_TOKEN_HASHER.keyFor('code', code) as string;
}

/**
 * Stores a client row exactly as given, as an older release could have
 * registered it (no registration request, so no validation).
 */
export async function plantClient(storage: Storage, client: Record<string, unknown>): Promise<void> {
  await storage.saveClient(client as unknown as OAuthClientInformationFull);
}

/** Overwrites fields of a registered client's stored row; returns nothing. */
export async function updateClient(
  storage: Storage,
  clientId: string,
  changes: Record<string, unknown>
): Promise<void> {
  const stored = await storage.getClient(clientId);
  if (!stored) throw new Error(`updateClient: no client ${clientId}`);
  await storage.saveClient({ ...stored, ...changes } as OAuthClientInformationFull);
}

/**
 * Registers a client through `POST /register` (dynamic client registration) and
 * returns the registration response. A client secret, when the method issues
 * one, is in the response only once, here.
 */
export async function registerTestClient(
  app: Express,
  body: {
    redirect_uris: string[];
    client_name?: string;
    token_endpoint_auth_method?: 'none' | 'client_secret_post';
    [field: string]: unknown;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app).post('/register').send(body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}
