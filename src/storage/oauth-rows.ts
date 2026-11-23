/**
 * Rules of the oidc-provider rows (`oauth_rows`, ADR-0002 D4) that every
 * driver shares: the model sets, the plain keys, the staged sign-in's
 * payload, and the account-tool view of a grant. The SQL sweep rules are in
 * ./retention.ts; the adapter that writes these rows is
 * src/auth/oidc/adapter.ts.
 *
 * A key is an opaque string to storage. Rows whose id is a credential are
 * keyed by `h1.` + HMAC (the adapter derives it); the rest by `<Model>:<id>`,
 * built here so storage can address a grant, a client or a staged sign-in by
 * id inside its own transactions.
 */

import type { ConnectionRecord, GrantedScope, OAuthModel, UserRecord } from './types.js';
import { parseGrantedScope } from '../auth/scope.js';
import { clientNameFromJson, optionalMillis } from './retention.js';

/** Every model a row may hold. */
export const OAUTH_MODELS: ReadonlySet<OAuthModel> = new Set<OAuthModel>([
  'AccessToken',
  'RefreshToken',
  'AuthorizationCode',
  'RegistrationAccessToken',
  'Session',
  'Interaction',
  'Grant',
  'Client',
  'SignIn',
]);

/**
 * Grant-bound credentials: saved only while their grant row exists, read only
 * while it still does and their user holds them (STOR-1), and deleted with
 * their grant.
 */
export const GRANT_TOKEN_MODELS: ReadonlySet<OAuthModel> = new Set<OAuthModel>([
  'AccessToken',
  'RefreshToken',
  'AuthorizationCode',
]);

/** The models a compare-and-set consume applies to. */
export const CONSUMABLE_MODELS: ReadonlySet<OAuthModel> = new Set<OAuthModel>(['RefreshToken', 'AuthorizationCode']);

/** The models keyed by their plain id. */
export type PlainKeyModel = 'Grant' | 'Client' | 'SignIn';

/** The key of a grant (by its id), a client (by its client_id) or a staged sign-in (by its grant's id). */
export function plainRowKey(model: PlainKeyModel, id: string): string {
  return `${model}:${id}`;
}

/** The fields of a {@link UserRecord} a staged sign-in carries; the user id is the row's `account_id`. */
interface SignInPayload {
  grantedScope: GrantedScope;
  encryptedRefreshToken: string;
  updatedAt: number;
}

/** A staged sign-in's payload (the YNAB refresh token is already encrypted by the caller). */
export function signInPayload(user: UserRecord): string {
  const payload: SignInPayload = {
    grantedScope: user.grantedScope,
    encryptedRefreshToken: user.encryptedRefreshToken,
    updatedAt: user.updatedAt,
  };
  return JSON.stringify(payload);
}

/** The user a staged sign-in applies; undefined when its payload is unreadable. */
export function userFromSignIn(accountId: string, payload: string): UserRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const p = parsed as Partial<Record<keyof SignInPayload, unknown>>;
  if (typeof p.encryptedRefreshToken !== 'string' || p.encryptedRefreshToken === '') return undefined;
  if (typeof p.updatedAt !== 'number' || !Number.isFinite(p.updatedAt)) return undefined;
  return {
    userId: accountId,
    grantedScope: parseGrantedScope(p.grantedScope),
    encryptedRefreshToken: p.encryptedRefreshToken,
    updatedAt: p.updatedAt,
  };
}

/** The scope words a grant payload's `resources` entry gives, per resource. */
function resourceScopes(value: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [resource, scope] of Object.entries(value as Record<string, unknown>)) {
    if (typeof scope === 'string') out.set(resource, new Set(scope.split(' ').filter(Boolean)));
  }
  return out;
}

/**
 * The access level an oidc-provider grant gives: read-write when any
 * resource's granted scope, less what the grant rejects, includes
 * `read-write` (D3, D7); read-only otherwise, and for an unreadable payload.
 */
export function grantedScopeOfGrant(payload: string): GrantedScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 'read-only';
  }
  if (parsed === null || typeof parsed !== 'object') return 'read-only';
  const grant = parsed as { resources?: unknown; rejected?: { resources?: unknown } | null };
  const rejected = resourceScopes(grant.rejected?.resources);
  for (const [resource, scopes] of resourceScopes(grant.resources)) {
    if (scopes.has('read-write') && !rejected.get(resource)?.has('read-write')) return 'read-write';
  }
  return 'read-only';
}

/**
 * One live access or refresh token of one of the user's grants, joined to the
 * grant and its client, as a driver reads it for {@link connectionsFromGrantRows}
 * (already filtered: the user's `Grant` rows, tokens unconsumed, unexpired and
 * issued under the user's current row).
 */
export interface GrantConnectionRow {
  grant_id: string;
  client_id: string | null;
  grant_payload: string;
  grant_created_at: string | number;
  /** The client's payload; null when the client is gone. */
  client_payload: string | null;
  token_created_at: string | number;
  token_expires_at: string | number | null;
}

/**
 * The account tools' view of the user's oidc-provider grants: one per grant,
 * created when the grant was, last used when its newest live token was
 * issued, expiring with its latest live token (the refresh token's idle limit
 * capped by the absolute one, as the library's TTL functions set it).
 */
export function connectionsFromGrantRows(rows: readonly GrantConnectionRow[]): ConnectionRecord[] {
  const byGrant = new Map<string, ConnectionRecord>();
  for (const row of rows) {
    const issuedAt = optionalMillis(row.token_created_at);
    const expiresAt = optionalMillis(row.token_expires_at);
    const seen = byGrant.get(row.grant_id);
    if (seen) {
      if ((issuedAt ?? 0) > (seen.lastUsedAt ?? 0)) seen.lastUsedAt = issuedAt;
      if ((expiresAt ?? 0) > (seen.expiresAt ?? 0)) seen.expiresAt = expiresAt;
      continue;
    }
    byGrant.set(row.grant_id, {
      familyId: row.grant_id,
      clientId: row.client_id ?? '',
      clientName: clientNameFromJson(row.client_payload),
      grantedScope: grantedScopeOfGrant(row.grant_payload),
      createdAt: optionalMillis(row.grant_created_at),
      lastUsedAt: issuedAt,
      expiresAt,
    });
  }
  return [...byGrant.values()];
}

/** Oldest first, then by id, as `Storage.listConnections` returns them. */
export function sortConnections(connections: ConnectionRecord[]): ConnectionRecord[] {
  return connections.sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.familyId.localeCompare(b.familyId)
  );
}
