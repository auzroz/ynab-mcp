/**
 * Plants OAuth state (clients, users, codes, access tokens) for the HTTP tests.
 *
 * The tests need a connected user, a registered client, an access token the
 * `/mcp` bearer check accepts, or a code the token endpoint can redeem, without
 * running the whole sign-in each time. Everything that depends on how the
 * authorization server stores them lives here, so the tests don't.
 *
 * Since the cut-over (#47-4) the authorization server is oidc-provider over
 * `oauth_rows` (ADR-0002 D4). State is planted through the library's own
 * models, on a helper-side provider over the same storage and the shared test
 * pepper ({@link TEST_TOKEN_HASHER}), so a planted row is exactly what the
 * app's provider would have written: an app built with `TOKEN_PEPPER` =
 * `TEST_TOKEN_PEPPER` reads it. Every token and code belongs to a grant, saved
 * first; a token or code is stored only while its user row exists (STOR-1), so
 * call {@link plantUser} before planting one.
 *
 * Each plant function returns what a client would hold: the bearer value or the
 * code, never the storage key.
 */

import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import type Provider from 'oidc-provider';
import type { Storage, UserRecord } from '../../../src/storage/types.js';
import { createOidcProvider } from '../../../src/auth/oidc/provider.js';
import { createOidcAdapter } from '../../../src/auth/oidc/adapter.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import { TEST_TOKEN_HASHER } from './token-hasher.js';

type GrantedScope = NonNullable<UserRecord['grantedScope']>;

/** The MCP resource the HTTP tests' apps serve (`PUBLIC_URL` + `/mcp`). */
export const TEST_RESOURCE = 'https://mcp.example.com/mcp';

/** One helper-side provider per storage: only its models are used, never its routes. */
const providers = new WeakMap<Storage, Provider>();

function libraryOver(storage: Storage): Provider {
  let provider = providers.get(storage);
  if (provider === undefined) {
    provider = createOidcProvider({
      store: storage,
      keys: TEST_TOKEN_HASHER,
      publicUrl: 'https://mcp.example.com',
      encryptionKey: randomBytes(32).toString('base64'),
      accessTokenTtlSec: 3600,
      authCodeTtlSec: 600,
    }).provider;
    providers.set(storage, provider);
  }
  return provider;
}

const epochSec = (ms: number): number => Math.floor(ms / 1000);

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

/** Saves a grant of `scopes` on `resource` for the user and client; returns its id. */
async function plantGrant(
  provider: Provider,
  grant: { clientId: string; userId: string; scopes: readonly string[]; resource: string }
): Promise<string> {
  const g = new provider.Grant({ accountId: grant.userId, clientId: grant.clientId });
  g.addResourceScope(grant.resource, grant.scopes.join(' '));
  return g.save();
}

/**
 * Stores an access token as the authorization server issues one and returns the
 * bearer value. `clientId`, `userId`, `scopes`, `expiresAt` (epoch ms) and
 * `resource` (its audience) are the token's claims. The access level is the
 * scope's (D7: read-write only when the scopes include `read-write`);
 * `grantedScope` is accepted for the callers' convenience and not stored.
 * The user must have been planted first.
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
  const provider = libraryOver(storage);
  const grantId = await plantGrant(provider, token);
  const at = new provider.AccessToken({
    accountId: token.userId,
    clientId: token.clientId,
    grantId,
    scope: token.scopes.join(' '),
    exp: epochSec(token.expiresAt),
  });
  at.setAudience(token.resource);
  return at.save();
}

/**
 * The value of a well-formed access token that was never stored, so the bearer
 * check refuses it as unknown.
 */
export function unknownAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Deletes the stored access token whose bearer value is `accessToken`. */
export async function revokePlantedAccessToken(storage: Storage, accessToken: string): Promise<void> {
  const token = await libraryOver(storage).AccessToken.find(accessToken);
  if (!token) throw new Error('revokePlantedAccessToken: no such token');
  await token.destroy();
}

/**
 * Stores an authorization code as the authorization server issues one and
 * returns the value a client redeems at `/token`. The client must be
 * registered. The code's save applies a staged sign-in (#94): the user's
 * existing row when there is one (so call {@link plantUser} first for a
 * user whose YNAB token the test needs), else a placeholder. `grantedScope`
 * is the user's YNAB grant level (default: the existing row's, else
 * read-only). `resource` defaults to {@link TEST_RESOURCE}.
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
    resource?: string;
  }
): Promise<string> {
  const provider = libraryOver(storage);
  const resource = code.resource ?? TEST_RESOURCE;
  // D7: an empty request is both levels; the grant holds what the code grants.
  const scopes = code.scopes.length > 0 ? code.scopes : ['read-only', 'read-write'];
  const grantId = await plantGrant(provider, { ...code, scopes, resource });
  const existing = await storage.getUser(code.userId);
  const staged = await storage.stageSignIn({
    grantId,
    user: {
      userId: code.userId,
      grantedScope: code.grantedScope ?? existing?.grantedScope ?? 'read-only',
      encryptedRefreshToken: existing?.encryptedRefreshToken ?? 'planted',
      updatedAt: Date.now(),
    },
    expiresAt: code.expiresAt,
  });
  if (!staged) throw new Error('plantAuthCode: the sign-in could not be staged');
  const ac = new provider.AuthorizationCode({
    accountId: code.userId,
    clientId: code.clientId,
    grantId,
    redirectUri: code.redirectUri,
    codeChallenge: code.codeChallenge,
    codeChallengeMethod: 'S256',
    scope: scopes.join(' '),
    resource,
    exp: epochSec(code.expiresAt),
  });
  return ac.save();
}

/** The storage key `plantAuthCode` stored `code` under, to look the row up directly (`findOAuthRow`). */
export function authCodeKey(code: string): string {
  return TEST_TOKEN_HASHER.libraryStorageKey('code', code) as string;
}

/**
 * Stores a client exactly as given, as an older release could have
 * registered it (no registration request, so none of today's DCR rules), in
 * the library's client store. A plaintext `client_secret` is stored as its
 * `s256.` hash, as the adapter stores every secret.
 */
export async function plantClient(storage: Storage, client: Record<string, unknown>): Promise<void> {
  const id = client['client_id'];
  if (typeof id !== 'string') throw new Error('plantClient: client_id is required');
  await createOidcAdapter({ store: storage, keys: TEST_TOKEN_HASHER })('Client').upsert(id, { ...client });
}

/** Overwrites fields of a registered client's stored metadata; returns nothing. */
export async function updateClient(
  storage: Storage,
  clientId: string,
  changes: Record<string, unknown>
): Promise<void> {
  const adapter = createOidcAdapter({ store: storage, keys: TEST_TOKEN_HASHER })('Client');
  const stored = await adapter.find(clientId);
  if (!stored) throw new Error(`updateClient: no client ${clientId}`);
  await adapter.upsert(clientId, { ...stored, ...changes });
}

/** A registered client's stored metadata (its `client_secret` is the `s256.` hash), or undefined. */
export async function storedClient(storage: Storage, clientId: string): Promise<Record<string, unknown> | undefined> {
  const row = await storage.findOAuthRow(plainRowKey('Client', clientId));
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
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
