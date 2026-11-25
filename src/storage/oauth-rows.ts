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

import { createHash } from 'node:crypto';
import type { ConnectionRecord, GrantedScope, OAuthModel, OAuthRowWrite, UserRecord } from './types.js';
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
  'RefreshGrace',
  'YnabTokenRejected',
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
export type PlainKeyModel = 'Grant' | 'Client' | 'SignIn' | 'RefreshGrace' | 'YnabTokenRejected';

/**
 * The key of a grant (by its id), a client (by its client_id), a staged
 * sign-in or #64a's refresh grace record (each by its grant's id), or a
 * rejected YNAB token's marker (by {@link rejectedYnabTokenId}).
 */
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
 * #64b: the payloads of the user's other grants that still hold a live
 * credential, read inside a sign-in's code save to decide whether its YNAB
 * token may replace the stored one ({@link signInKeepsStoredToken}). Live is:
 * an unexpired AccessToken; an unconsumed, unexpired RefreshToken; or an
 * unexpired AuthorizationCode, consumed or not. A consumed code still counts
 * because the library consumes it before it saves the exchange's tokens, so a
 * read-write client in the middle of its exchange has only its code; a code
 * that was replayed or revoked is gone with its grant, so a consumed code
 * still on file belongs to a live grant. Other models (RefreshGrace, SignIn,
 * YnabTokenRejected) never count.
 *
 * Parameters, each `$n` once and in order (SQLite's positional form): the
 * account, the grant to leave out (the sign-in's own), then `now` three times.
 */
export const OTHER_LIVE_GRANTS_SQL = `SELECT g.payload FROM oauth_rows g
  WHERE g.model = 'Grant' AND g.account_id = $1 AND g.grant_id <> $2
    AND EXISTS (SELECT 1 FROM oauth_rows t WHERE t.grant_id = g.grant_id AND (
      (t.model = 'AccessToken' AND t.expires_at >= $3)
      OR (t.model = 'RefreshToken' AND t.consumed_at IS NULL AND (t.expires_at IS NULL OR t.expires_at >= $4))
      OR (t.model = 'AuthorizationCode' AND t.expires_at >= $5)))`;

/** The parameters of {@link OTHER_LIVE_GRANTS_SQL}. */
export function otherLiveGrantsParams(accountId: string, grantId: string, now: number): unknown[] {
  return [accountId, grantId, now, now, now];
}

/**
 * #64b (the D-9 result: a second, read-only YNAB authorization doesn't
 * invalidate the first, read-write one). A completed sign-in keeps the stored
 * YNAB token, and discards its own, when it brings a read-only token, the
 * stored one is read-write, YNAB hasn't rejected it (`storedRejected`, a
 * {@link rejectedYnabTokenRow} marker for its exact ciphertext), and another
 * of the user's grants is read-write and live (its payloads from
 * {@link OTHER_LIVE_GRANTS_SQL}). Otherwise the sign-in's token replaces the
 * stored one, as before: read-only after read-only, any read-write,
 * read-only once no read-write grant is left, or read-only over a token YNAB
 * has refused (keeping a dead token would leave the reconnect looking
 * successful while YNAB access stays broken).
 *
 * Keeping the read-write token widens nothing: each request's level is its
 * own token's scope AND the user's YNAB level (http.ts), so the new client's
 * read-only grant stays read-only. The discarded read-only authorization
 * stays valid at YNAB, unreferenced (YNAB has no revocation endpoint).
 */
export function signInKeepsStoredToken(
  stored: Pick<UserRecord, 'grantedScope'> | undefined,
  incoming: Pick<UserRecord, 'grantedScope'>,
  otherLiveGrantPayloads: readonly string[],
  storedRejected: boolean
): boolean {
  return (
    incoming.grantedScope === 'read-only' &&
    stored?.grantedScope === 'read-write' &&
    !storedRejected &&
    otherLiveGrantPayloads.some((payload) => grantedScopeOfGrant(payload) === 'read-write')
  );
}

const REJECTED_TOKEN_DOMAIN = 'ynab-mcp/ynab-token-rejected/v1';

/**
 * #64b: the id of a rejected YNAB token's marker, SHA-256 (hex) of a domain
 * tag, the user id and the stored refresh-token ciphertext YNAB refused.
 *
 * Unkeyed, unlike the `h1.` keys: every driver computes it inside the
 * sign-in's transaction from the ciphertext it reads there, and storage has
 * no pepper. A key adds no secrecy here: the input is AES-GCM ciphertext
 * (random IV) that the same database's `users` row held, never a token value,
 * and the hash can't be opened or guessed. Not `h1.`, which means a peppered
 * HMAC of a credential everywhere else.
 */
export function rejectedYnabTokenId(userId: string, encryptedRefreshToken: string): string {
  return createHash('sha256').update(`${REJECTED_TOKEN_DOMAIN}\0${userId}\0${encryptedRefreshToken}`).digest('hex');
}

/** The key of the marker for `encryptedRefreshToken` of `userId`. */
export function rejectedYnabTokenKey(userId: string, encryptedRefreshToken: string): string {
  return plainRowKey('YnabTokenRejected', rejectedYnabTokenId(userId, encryptedRefreshToken));
}

/**
 * #64b: the marker YnabTokenResolver writes when YNAB refuses the stored
 * refresh token with `invalid_grant` (the token is dead; any other refusal,
 * such as `invalid_client`, may be this server's fault and marks nothing). A
 * completed sign-in reads it ({@link signInKeepsStoredToken}'s
 * `storedRejected`) against the ciphertext stored at that moment, so a newer
 * token (a refresh, a sign-in) never matches it, on any replica. The rekey
 * job's re-encryption of the same token carries it to the new ciphertext, in
 * the same step (`rekeyUserRefreshToken`); a rekey during the refused refresh
 * is caught by the writer's re-read (YnabTokenResolver.markRejected), which
 * also removes a marker written while the account was being erased.
 *
 * In the clear it holds only the key (a hash), the user id (`account_id`, so
 * the account's erasure deletes it) and its expiry; no grant or client, so it
 * never keeps a grant or a client from the sweep. It expires at `expiresAt`:
 * the writer sets the grant lifetime from now (every read-write grant that
 * could keep the dead token was live when it was written, and ends within
 * that), and the sweep's expiry rule then removes it. Every later refusal
 * rewrites it, restarting that clock.
 */
export function rejectedYnabTokenRow(userId: string, encryptedRefreshToken: string, expiresAt: number): OAuthRowWrite {
  return {
    key: rejectedYnabTokenKey(userId, encryptedRefreshToken),
    model: 'YnabTokenRejected',
    payload: '{}',
    grantId: undefined,
    accountId: userId,
    clientId: undefined,
    uid: undefined,
    expiresAt,
  };
}

/**
 * The marker for `encryptedRefreshToken` of `accountId`, as its `expires_at`;
 * no row when there is none. A sign-in counts it whatever its expiry (a
 * refused YNAB token never works again; expiry only bounds how long the row
 * is kept). Parameters: the marker's key, the account.
 */
export const REJECTED_YNAB_TOKEN_SQL = `SELECT expires_at FROM oauth_rows
  WHERE key = $1 AND model = 'YnabTokenRejected' AND account_id = $2`;

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
