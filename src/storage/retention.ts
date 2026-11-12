/**
 * Retention rules shared by the storage drivers (#53, #54): refresh-token
 * expiry, the account-generation check on token reads, and the batched
 * `sweepExpired` statements for the SQL drivers.
 *
 * Timestamps are epoch ms from the storage clock (`Date.now()` in this
 * process), the same clock that stamps `issued_at`, `family_created_at` and
 * `users.created_at`; comparing them with the database server's clock would
 * mix two clocks.
 */

import type { RetentionPolicy } from '../auth/retention-defaults.js';
import { SWEEP_BATCH_SIZE } from '../auth/retention-defaults.js';
import type { Dialect } from './migrations.js';
import type { ConnectionRecord, SweepCounts } from './types.js';
import { parseOptionalGrantedScope } from '../auth/scope.js';

/**
 * When a refresh token stops being usable: `idle` after it was issued, but no
 * later than `ttl` after its family was created. A NULL clock (a row written by
 * a 0.4.x replica since the last startup's backfill) sets no limit until the
 * next startup stamps it.
 */
export function refreshTokenExpiresAt(
  issuedAt: number | null | undefined,
  familyCreatedAt: number | null | undefined,
  policy: RetentionPolicy
): number {
  const idle = issuedAt == null ? Infinity : issuedAt + policy.refreshTokenIdleMs;
  const absolute = familyCreatedAt == null ? Infinity : familyCreatedAt + policy.refreshTokenTtlMs;
  return Math.min(idle, absolute);
}

/** True when a refresh token is past its idle or absolute limit at `now`. */
export function refreshTokenExpired(
  issuedAt: number | null | undefined,
  familyCreatedAt: number | null | undefined,
  policy: RetentionPolicy,
  now: number
): boolean {
  return refreshTokenExpiresAt(issuedAt, familyCreatedAt, policy) < now;
}

/**
 * The account-generation invariant: a token is valid only for the user row it
 * was issued under, `issued_at >= COALESCE(users.created_at, 0)`. A token
 * written without `issued_at` (by a 0.4.x replica) passes; every token this
 * release writes has one.
 */
export function issuedUnderUser(
  issuedAt: number | null | undefined,
  userCreatedAt: number | null | undefined
): boolean {
  return issuedAt == null || issuedAt >= (userCreatedAt ?? 0);
}

/** The same invariant in SQL, for token alias `t` joined to `users u`. */
export function issuedUnderUserSql(t: string): string {
  return `(${t}.issued_at IS NULL OR ${t}.issued_at >= COALESCE(u.created_at, 0))`;
}

/** Converts a nullable BIGINT column (a string from `pg`) to a number. */
export function optionalMillis(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'number' ? value : Number(value);
}

/** A registered client's self-declared name, if it is a string. */
export function clientName(client: { client_name?: unknown } | undefined): string | undefined {
  const name = client?.client_name;
  return typeof name === 'string' ? name : undefined;
}

/** A client's self-declared name from its stored JSON; undefined if absent or unreadable. */
export function clientNameFromJson(json: string | null | undefined): string | undefined {
  if (json == null) return undefined;
  try {
    return clientName(JSON.parse(json) as { client_name?: unknown });
  } catch {
    return undefined;
  }
}

/** A refresh token joined to its client, as the SQL drivers read it for {@link connectionsFromRows}. */
export interface ConnectionRow {
  family_id: string;
  client_id: string;
  granted_scope: string | null;
  issued_at: string | number | null;
  family_created_at: string | number | null;
  client_json: string | null;
}

/**
 * The user's live grants from their refresh tokens (already filtered to the
 * user, a family, and the generation invariant): one per family, the newest
 * token's clocks, expired ones dropped, oldest grant first.
 */
export function connectionsFromRows(
  rows: readonly ConnectionRow[],
  policy: RetentionPolicy,
  now: number
): ConnectionRecord[] {
  const byFamily = new Map<string, ConnectionRecord>();
  for (const row of rows) {
    const issuedAt = optionalMillis(row.issued_at);
    const familyCreatedAt = optionalMillis(row.family_created_at);
    if (refreshTokenExpired(issuedAt, familyCreatedAt, policy, now)) continue;
    const seen = byFamily.get(row.family_id);
    if (seen && (seen.lastUsedAt ?? 0) >= (issuedAt ?? 0)) continue;
    const expiresAt = refreshTokenExpiresAt(issuedAt, familyCreatedAt, policy);
    byFamily.set(row.family_id, {
      familyId: row.family_id,
      clientId: row.client_id,
      clientName: clientNameFromJson(row.client_json),
      grantedScope: parseOptionalGrantedScope(row.granted_scope) ?? 'read-only',
      createdAt: familyCreatedAt,
      lastUsedAt: issuedAt,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    });
  }
  return [...byFamily.values()].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.familyId.localeCompare(b.familyId)
  );
}

export function emptySweepCounts(): SweepCounts {
  return {
    pendingAuth: 0,
    authCodes: 0,
    accessTokens: 0,
    refreshTokens: 0,
    consumedRefreshTokens: 0,
    consumedAuthCodes: 0,
    orphanTokens: 0,
    abandonedClients: 0,
    unusedClients: 0,
  };
}

/** Runs one statement outside any explicit transaction and returns the rows it changed. */
export interface SweepExecutor {
  readonly dialect: Dialect;
  run(sql: string, params: readonly unknown[]): Promise<number>;
}

interface SweepRule {
  counter: keyof SweepCounts;
  table: string;
  key: string;
  /** Selects up to `$n` keys (the last parameter); `{lock}` is replaced per dialect. */
  select: string;
  params: readonly unknown[];
}

/**
 * A client with nothing in flight and no tokens: no pending authorization, no
 * code, no spent code waiting for its exchange (`consumed_auth_codes`, which a
 * revoked or expired tombstone also keeps until the sweep removes it), and no
 * token. The one gap these rows leave, the YNAB code exchange between
 * `takePendingAuth` and `saveAuthCode`, is covered by `last_seen_at`, which
 * `takePendingAuth` stamps in the same step. It protects the client for at
 * least `MIN_ABANDONED_CLIENT_MS`, and a callback past the shorter
 * `YNAB_CALLBACK_DEADLINE_MS` saves no code.
 */
const CLIENT_HAS_NO_GRANT = `
  NOT EXISTS (SELECT 1 FROM pending_auth p WHERE p.client_id = c.client_id)
  AND NOT EXISTS (SELECT 1 FROM auth_codes a WHERE a.client_id = c.client_id)
  AND NOT EXISTS (SELECT 1 FROM consumed_auth_codes k WHERE k.client_id = c.client_id)
  AND NOT EXISTS (SELECT 1 FROM access_tokens t WHERE t.client_id = c.client_id)
  AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.client_id = c.client_id)`;

function sweepRules(now: number, policy: RetentionPolicy): SweepRule[] {
  const expired = (counter: keyof SweepCounts, table: string, key: string): SweepRule => ({
    counter,
    table,
    key,
    select: `SELECT ${key} FROM ${table} WHERE expires_at < $1 LIMIT $2 {lock}`,
    params: [now],
  });
  const orphans = (table: string): SweepRule => ({
    counter: 'orphanTokens',
    table,
    key: 'token',
    select: `SELECT t.token FROM ${table} t LEFT JOIN users u ON u.user_id = t.user_id
      WHERE u.user_id IS NULL OR t.issued_at < COALESCE(u.created_at, 0) LIMIT $1 {lock:t}`,
    params: [],
  });
  return [
    expired('pendingAuth', 'pending_auth', 'state'),
    expired('authCodes', 'auth_codes', 'code'),
    expired('accessTokens', 'access_tokens', 'token'),
    {
      counter: 'refreshTokens',
      table: 'refresh_tokens',
      key: 'token',
      select: `SELECT token FROM refresh_tokens WHERE issued_at < $1 OR family_created_at < $2 LIMIT $3 {lock}`,
      params: [now - policy.refreshTokenIdleMs, now - policy.refreshTokenTtlMs],
    },
    expired('consumedRefreshTokens', 'consumed_refresh_tokens', 'token'),
    expired('consumedAuthCodes', 'consumed_auth_codes', 'code'),
    orphans('access_tokens'),
    orphans('refresh_tokens'),
    {
      counter: 'abandonedClients',
      table: 'oauth_clients',
      key: 'client_id',
      select: `SELECT c.client_id FROM oauth_clients c
        WHERE c.last_authorized_at IS NULL AND c.created_at < $1
          AND (c.last_seen_at IS NULL OR c.last_seen_at < $2) AND ${CLIENT_HAS_NO_GRANT}
        LIMIT $3 {lock:c}`,
      params: [now - policy.abandonedClientMs, now - policy.abandonedClientMs],
    },
    {
      counter: 'unusedClients',
      table: 'oauth_clients',
      key: 'client_id',
      select: `SELECT c.client_id FROM oauth_clients c
        WHERE c.last_authorized_at < $1
          AND (c.last_seen_at IS NULL OR c.last_seen_at < $2) AND ${CLIENT_HAS_NO_GRANT}
        LIMIT $3 {lock:c}`,
      params: [now - policy.unusedClientMs, now - policy.abandonedClientMs],
    },
  ];
}

/**
 * Run every sweep rule in batches of `batchSize` rows, each batch its own
 * statement (and so its own short transaction). On Postgres a batch skips rows
 * another transaction holds (`SKIP LOCKED`), which a later sweep picks up.
 */
export async function runSqlSweep(
  exec: SweepExecutor,
  now: number,
  policy: RetentionPolicy,
  batchSize: number = SWEEP_BATCH_SIZE
): Promise<SweepCounts> {
  const counts = emptySweepCounts();
  for (const rule of sweepRules(now, policy)) {
    const select = rule.select.replace(/\{lock(?::(\w+))?\}/, (_m, alias: string | undefined) =>
      exec.dialect === 'postgres' ? `FOR UPDATE${alias ? ` OF ${alias}` : ''} SKIP LOCKED` : ''
    );
    const sql = `DELETE FROM ${rule.table} WHERE ${rule.key} IN (${select})`;
    for (;;) {
      const deleted = await exec.run(sql, [...rule.params, batchSize]);
      counts[rule.counter] += deleted;
      if (deleted < batchSize) break;
    }
  }
  return counts;
}
