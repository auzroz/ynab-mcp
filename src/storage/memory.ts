/**
 * In-memory storage adapter (zero dependencies).
 *
 * The default driver: works out of the box for single-node / development and is
 * the target for the test suite. NOTE: state is lost on restart — use the SQLite
 * or Postgres driver for durable multi-user deployments.
 *
 * Every method runs to completion without an await, so each is atomic; the
 * retention clocks the SQL drivers keep in columns (`issued_at`,
 * `family_created_at`, `users.created_at`, the client clocks) are kept beside
 * the records and never returned.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type {
  Storage,
  UserRecord,
  AuthCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  RefreshTokenRotation,
  ConsumedRefreshTokenRecord,
  ConsumedAuthCodeRecord,
  AuthCodeConsumption,
  CodeTokens,
  PendingAuthRecord,
  GrantedScope,
  ConnectionRecord,
  StorageDriverOptions,
  SweepOptions,
  SweepResult,
  OAuthRowStore,
  OAuthRowWrite,
  OAuthRowRecord,
  StagedSignIn,
  CodeSaveOutcome,
  ConsumeOutcome,
} from './types.js';
import { parseGrantedScope, parseOptionalGrantedScope } from '../auth/scope.js';
import {
  CONSUMED_CREDENTIAL_RETENTION_MS,
  retentionPolicy,
  type RetentionPolicy,
} from '../auth/retention-defaults.js';
import {
  CONSUMABLE_MODELS,
  GRANT_TOKEN_MODELS,
  connectionsFromGrantRows,
  plainRowKey,
  signInPayload,
  sortConnections,
  userFromSignIn,
  type GrantConnectionRow,
} from './oauth-rows.js';
import {
  connectionsFromRows,
  emptySweepCounts,
  issuedUnderUser,
  refreshTokenExpired,
  type ConnectionRow,
} from './retention.js';

/**
 * The access level is checked at the read, as in the durable drivers, so an
 * unexpected value (the types forbid one, but a caller may cast) reads as
 * read-only. A missing level stays missing; callers treat it as read-only.
 */
function withOptionalScope<T extends { grantedScope?: GrantedScope | undefined }>(rec: T): T {
  const grantedScope = parseOptionalGrantedScope(rec.grantedScope);
  return grantedScope === undefined ? rec : { ...rec, grantedScope };
}

interface StoredAccessToken {
  rec: AccessTokenRecord;
  issuedAt: number;
}

interface StoredRefreshToken {
  rec: RefreshTokenRecord;
  issuedAt: number;
  familyCreatedAt: number;
}

interface StoredClient {
  client: OAuthClientInformationFull;
  createdAt: number;
  lastAuthorizedAt: number | undefined;
  /** When an authorization of this client last reached the YNAB callback (takePendingAuth). */
  lastSeenAt: number | undefined;
}

interface StoredConsumedRefreshToken {
  rec: ConsumedRefreshTokenRecord;
  userId: string;
}

export class MemoryStorage implements Storage, OAuthRowStore {
  private users = new Map<string, UserRecord>();
  private clients = new Map<string, StoredClient>();
  private pending = new Map<string, PendingAuthRecord>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private accessTokens = new Map<string, StoredAccessToken>();
  private refreshTokens = new Map<string, StoredRefreshToken>();
  private consumedRefreshTokens = new Map<string, StoredConsumedRefreshToken>();
  private consumedAuthCodes = new Map<string, ConsumedAuthCodeRecord>();
  /** `oauth_rows` (ADR-0002 D4), by key. */
  private oauthRows = new Map<string, OAuthRowRecord>();
  private readonly retention: RetentionPolicy;

  constructor(options: StorageDriverOptions = {}) {
    this.retention = retentionPolicy(options.retention);
  }

  async init(): Promise<void> {
    // no-op
  }
  async close(): Promise<void> {
    this.users.clear();
    this.clients.clear();
    this.pending.clear();
    this.authCodes.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
    this.consumedRefreshTokens.clear();
    this.consumedAuthCodes.clear();
    this.oauthRows.clear();
  }

  // Users + YNAB tokens

  async upsertUser(rec: UserRecord): Promise<void> {
    this.putUser(rec);
  }
  /** created_at is set by the insert only, from the storage clock (`now`, when the caller holds one instant). */
  private putUser(rec: UserRecord, now: number = Date.now()): void {
    const existing = this.users.get(rec.userId);
    this.users.set(rec.userId, { ...rec, createdAt: existing ? existing.createdAt : now });
  }
  async getUser(userId: string): Promise<UserRecord | undefined> {
    const rec = this.users.get(userId);
    return rec && { ...rec, grantedScope: parseGrantedScope(rec.grantedScope) };
  }
  async updateUserRefreshToken(
    userId: string,
    oldCiphertext: string,
    newCiphertext: string
  ): Promise<UserRecord | undefined> {
    const rec = this.users.get(userId);
    if (!rec || rec.encryptedRefreshToken !== oldCiphertext) return undefined;
    const updated = { ...rec, encryptedRefreshToken: newCiphertext, updatedAt: Date.now() };
    this.users.set(userId, updated);
    return { ...updated, grantedScope: parseGrantedScope(updated.grantedScope) };
  }
  async deleteUser(userId: string): Promise<void> {
    this.users.delete(userId);
  }

  async deleteUserData(userId: string): Promise<void> {
    const families = new Set<string>();
    this.users.delete(userId);
    for (const [key, rec] of this.authCodes) {
      if (rec.userId === userId) this.authCodes.delete(key);
    }
    for (const [key, { rec }] of this.accessTokens) {
      if (rec.userId !== userId) continue;
      if (rec.familyId !== undefined) families.add(rec.familyId);
      this.accessTokens.delete(key);
    }
    for (const [key, { rec }] of this.refreshTokens) {
      if (rec.userId !== userId) continue;
      if (rec.familyId !== undefined) families.add(rec.familyId);
      this.refreshTokens.delete(key);
    }
    for (const [key, rec] of this.consumedAuthCodes) {
      if (rec.userId !== userId) continue;
      families.add(rec.familyId);
      this.consumedAuthCodes.delete(key);
    }
    // A family whose live tokens are gone is still named by its tombstones.
    for (const stored of this.consumedRefreshTokens.values()) {
      if (stored.userId === userId) families.add(stored.rec.familyId);
    }
    for (const [key, stored] of this.consumedRefreshTokens) {
      if (stored.userId === userId || families.has(stored.rec.familyId)) this.consumedRefreshTokens.delete(key);
    }
    // oauth_rows: everything with the user's account id, and every row of the user's grants.
    const grants = new Set<string>();
    for (const row of this.oauthRows.values()) {
      if (row.model === 'Grant' && row.accountId === userId && row.grantId !== undefined) grants.add(row.grantId);
    }
    for (const [key, row] of this.oauthRows) {
      if (row.accountId === userId || (row.grantId !== undefined && grants.has(row.grantId))) {
        this.oauthRows.delete(key);
      }
    }
  }

  // Account self-service

  async listConnections(userId: string): Promise<ConnectionRecord[]> {
    const rows: ConnectionRow[] = [];
    for (const stored of this.refreshTokens.values()) {
      const { rec } = stored;
      if (rec.userId !== userId || rec.familyId === undefined) continue;
      if (!this.userHolds(rec.userId, stored.issuedAt)) continue;
      const client = this.clients.get(rec.clientId)?.client;
      rows.push({
        family_id: rec.familyId,
        client_id: rec.clientId,
        granted_scope: rec.grantedScope ?? null,
        issued_at: stored.issuedAt,
        family_created_at: stored.familyCreatedAt,
        client_json: client ? JSON.stringify(client) : null,
      });
    }
    const now = Date.now();
    return sortConnections([
      ...connectionsFromRows(rows, this.retention, now),
      ...connectionsFromGrantRows(this.grantConnectionRows(userId, now)),
    ]);
  }

  /** As the SQL drivers' join: the user's grants, each with its live tokens issued under the user's row. */
  private grantConnectionRows(userId: string, now: number): GrantConnectionRow[] {
    const out: GrantConnectionRow[] = [];
    for (const grant of this.oauthRows.values()) {
      if (grant.model !== 'Grant' || grant.accountId !== userId || grant.grantId === undefined) continue;
      const client = grant.clientId === undefined ? undefined : this.oauthRows.get(plainRowKey('Client', grant.clientId));
      for (const token of this.oauthRows.values()) {
        if (token.model !== 'AccessToken' && token.model !== 'RefreshToken') continue;
        if (token.grantId !== grant.grantId || token.consumedAt !== undefined) continue;
        if (token.expiresAt === undefined || token.expiresAt < now) continue;
        if (token.accountId === undefined || !this.userHolds(token.accountId, token.createdAt)) continue;
        out.push({
          grant_id: grant.grantId,
          client_id: grant.clientId ?? null,
          grant_payload: grant.payload,
          grant_created_at: grant.createdAt,
          client_payload: client?.model === 'Client' ? client.payload : null,
          token_created_at: token.createdAt,
          token_expires_at: token.expiresAt,
        });
      }
    }
    return out;
  }

  async revokeUserFamily(userId: string, familyId: string): Promise<boolean> {
    const legacy = this.revokeWhere((rec) => rec.userId === userId && rec.familyId === familyId) > 0;
    const grant = this.oauthRows.get(plainRowKey('Grant', familyId));
    const library =
      grant?.model === 'Grant' && grant.accountId === userId ? this.revokeGrantSync(familyId) > 0 : false;
    return legacy || library;
  }

  async deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number> {
    const legacy = this.revokeWhere((rec) => rec.userId === userId && rec.clientId === clientId);
    const grants: string[] = [];
    for (const row of this.oauthRows.values()) {
      if (row.model === 'Grant' && row.accountId === userId && row.clientId === clientId && row.grantId !== undefined) {
        grants.push(row.grantId);
      }
    }
    for (const grantId of grants) this.revokeGrantSync(grantId);
    return legacy + grants.length;
  }

  /**
   * Delete the tokens and revoke the code tombstones matching `match`. Returns
   * the number of families touched (a token without a family counts as one).
   */
  private revokeWhere(
    match: (rec: { userId?: string | undefined; clientId: string; familyId?: string | undefined }) => boolean
  ): number {
    const families = new Set<string>();
    let unfamilied = 0;
    const note = (familyId: string | undefined): void => {
      if (familyId === undefined) unfamilied++;
      else families.add(familyId);
    };
    for (const [key, { rec }] of this.accessTokens) {
      if (!match(rec)) continue;
      if (rec.familyId !== undefined) families.add(rec.familyId);
      this.accessTokens.delete(key);
    }
    for (const [key, { rec }] of this.refreshTokens) {
      if (!match(rec)) continue;
      note(rec.familyId);
      this.refreshTokens.delete(key);
    }
    for (const [key, rec] of this.consumedAuthCodes) {
      if (rec.revoked || !match(rec)) continue;
      families.add(rec.familyId);
      this.consumedAuthCodes.set(key, { ...rec, revoked: true });
    }
    return families.size + unfamilied;
  }

  // MCP clients

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId)?.client;
  }
  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    const existing = this.clients.get(client.client_id);
    this.clients.set(client.client_id, {
      client,
      createdAt: existing ? existing.createdAt : Date.now(),
      lastAuthorizedAt: existing?.lastAuthorizedAt,
      lastSeenAt: existing?.lastSeenAt,
    });
  }

  async savePendingAuth(rec: PendingAuthRecord): Promise<void> {
    this.pending.set(rec.state, rec);
  }
  async takePendingAuth(state: string): Promise<PendingAuthRecord | undefined> {
    const rec = this.pending.get(state);
    this.pending.delete(state);
    // The client is in the middle of an authorization (see sweepExpired).
    const client = rec && this.clients.get(rec.clientId);
    if (client) client.lastSeenAt = Date.now();
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return { ...rec, grantedScope: parseGrantedScope(rec.grantedScope) };
  }

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    this.authCodes.set(rec.code, rec);
  }
  async completeAuthorization(input: { user: UserRecord; code: AuthCodeRecord }): Promise<boolean> {
    // Synchronous from the check to the last write, so nothing interleaves.
    const client = this.clients.get(input.code.clientId);
    if (!client) return false;
    client.lastSeenAt = Date.now();
    this.putUser(input.user);
    this.authCodes.set(input.code.code, input.code);
    return true;
  }
  async takeAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
    const rec = this.authCodes.get(code);
    this.authCodes.delete(code);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return withOptionalScope(rec);
  }

  async consumeAuthCode(
    code: string,
    consumption: AuthCodeConsumption
  ): Promise<AuthCodeRecord | undefined> {
    const rec = this.authCodes.get(code);
    this.authCodes.delete(code);
    const now = Date.now();
    for (const [key, consumed] of this.consumedAuthCodes) {
      if (consumed.expiresAt < now) this.consumedAuthCodes.delete(key);
    }
    if (!rec || rec.expiresAt < now) return undefined;
    // A code is spent once, so its tombstone is never overwritten.
    if (!this.consumedAuthCodes.has(code)) {
      this.consumedAuthCodes.set(code, {
        code,
        clientId: rec.clientId,
        userId: rec.userId,
        familyId: consumption.familyId,
        expiresAt: consumption.consumedUntil,
        revoked: false,
      });
    }
    return rec;
  }

  async getConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined> {
    const rec = this.consumedAuthCodes.get(code);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return { ...rec };
  }

  async revokeConsumedAuthCode(code: string): Promise<ConsumedAuthCodeRecord | undefined> {
    const rec = this.consumedAuthCodes.get(code);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    const revoked = { ...rec, revoked: true };
    this.consumedAuthCodes.set(code, revoked);
    this.deleteFamilySync(rec.familyId);
    return { ...revoked };
  }

  async saveCodeTokens(code: string, tokens: CodeTokens): Promise<boolean> {
    const rec = this.consumedAuthCodes.get(code);
    const now = Date.now();
    if (!rec || rec.expiresAt < now || rec.revoked || rec.familyId !== tokens.familyId) {
      return false;
    }
    if (!this.users.has(tokens.refreshToken.userId)) return false;
    this.accessTokens.set(tokens.accessToken.token, { rec: tokens.accessToken, issuedAt: now });
    this.refreshTokens.set(tokens.refreshToken.token, {
      rec: tokens.refreshToken,
      issuedAt: now,
      familyCreatedAt: now,
    });
    const client = this.clients.get(tokens.refreshToken.clientId);
    if (client) client.lastAuthorizedAt = now;
    return true;
  }

  async saveAccessToken(rec: AccessTokenRecord): Promise<void> {
    this.accessTokens.set(rec.token, { rec, issuedAt: Date.now() });
  }
  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const stored = this.accessTokens.get(token);
    if (!stored) return undefined;
    if (stored.rec.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      return undefined;
    }
    if (!this.userHolds(stored.rec.userId, stored.issuedAt)) return undefined;
    return withOptionalScope(stored.rec);
  }
  async deleteAccessToken(token: string): Promise<void> {
    this.accessTokens.delete(token);
  }

  async saveRefreshToken(rec: RefreshTokenRecord): Promise<void> {
    const now = Date.now();
    this.refreshTokens.set(rec.token, { rec, issuedAt: now, familyCreatedAt: now });
  }
  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const stored = this.refreshTokens.get(token);
    if (!stored) return undefined;
    if (refreshTokenExpired(stored.issuedAt, stored.familyCreatedAt, this.retention, Date.now())) {
      this.refreshTokens.delete(token);
      return undefined;
    }
    if (!this.userHolds(stored.rec.userId, stored.issuedAt)) return undefined;
    return withOptionalScope(stored.rec);
  }
  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const stored = this.refreshTokens.get(token);
    this.refreshTokens.delete(token);
    if (!stored || !this.liveRefreshToken(stored, Date.now())) return undefined;
    return withOptionalScope(stored.rec);
  }
  async deleteRefreshToken(token: string): Promise<void> {
    this.refreshTokens.delete(token);
  }
  async rotateRefreshToken(
    token: string,
    rotation: RefreshTokenRotation
  ): Promise<RefreshTokenRecord | undefined> {
    const stored = this.refreshTokens.get(token);
    const userId = rotation.refreshToken.userId;
    // As on Postgres: no user row (or another user's token) leaves the row alone.
    if (!stored || stored.rec.userId !== userId || !this.users.has(userId)) return undefined;
    this.refreshTokens.delete(token);
    const now = Date.now();
    // Expired, or from an erased account: spent with no tombstone and no new pair.
    if (!this.liveRefreshToken(stored, now)) return undefined;
    for (const [key, consumed] of this.consumedRefreshTokens) {
      if (consumed.rec.expiresAt < now) this.consumedRefreshTokens.delete(key);
    }
    this.consumedRefreshTokens.set(token, {
      rec: {
        token,
        clientId: stored.rec.clientId,
        familyId: rotation.familyId,
        expiresAt: rotation.consumedUntil,
      },
      userId: stored.rec.userId,
    });
    this.accessTokens.set(rotation.accessToken.token, { rec: rotation.accessToken, issuedAt: now });
    this.refreshTokens.set(rotation.refreshToken.token, {
      rec: rotation.refreshToken,
      issuedAt: now,
      familyCreatedAt: stored.familyCreatedAt,
    });
    return withOptionalScope(stored.rec);
  }

  async getConsumedRefreshToken(token: string): Promise<ConsumedRefreshTokenRecord | undefined> {
    const stored = this.consumedRefreshTokens.get(token);
    if (!stored || stored.rec.expiresAt < Date.now()) return undefined;
    return stored.rec;
  }

  async deleteTokenFamily(familyId: string): Promise<void> {
    this.deleteFamilySync(familyId);
  }

  // oidc-provider rows (OAuthRowStore, ADR-0002 D4). Each method runs without
  // an await, so it is one atomic step.

  async upsertOAuthRow(row: OAuthRowWrite): Promise<void> {
    if (GRANT_TOKEN_MODELS.has(row.model) || row.model === 'SignIn') {
      throw new Error(`upsertOAuthRow cannot write a ${row.model} row`);
    }
    this.putOAuthRow(row, Date.now());
  }

  async saveGrantToken(row: OAuthRowWrite): Promise<boolean> {
    if (row.model !== 'AccessToken' && row.model !== 'RefreshToken') {
      throw new Error(`saveGrantToken cannot write a ${row.model} row`);
    }
    if (!this.liveGrantFor(row) || row.accountId === undefined || !this.users.has(row.accountId)) return false;
    this.putOAuthRow(row, Date.now());
    return true;
  }

  async saveAuthorizationCode(row: OAuthRowWrite): Promise<CodeSaveOutcome> {
    if (row.model !== 'AuthorizationCode') throw new Error(`saveAuthorizationCode cannot write a ${row.model} row`);
    const now = Date.now();
    const client = row.clientId === undefined ? undefined : this.oauthRows.get(plainRowKey('Client', row.clientId));
    if (client?.model !== 'Client') return 'client-gone';
    if (!this.liveGrantFor(row) || row.grantId === undefined || row.accountId === undefined) return 'grant-gone';
    const signInKey = plainRowKey('SignIn', row.grantId);
    const signIn = this.oauthRows.get(signInKey);
    if (signIn?.model !== 'SignIn' || signIn.accountId !== row.accountId) return 'no-sign-in';
    if (signIn.expiresAt === undefined || signIn.expiresAt < now) return 'no-sign-in';
    const user = userFromSignIn(row.accountId, signIn.payload);
    if (!user) return 'no-sign-in';
    // Synchronous from the client check to the last write, so nothing interleaves.
    client.authorizedAt = now;
    this.putUser(user, now);
    this.oauthRows.delete(signInKey);
    this.putOAuthRow(row, now);
    return 'saved';
  }

  async stageSignIn(signIn: StagedSignIn): Promise<boolean> {
    const grant = this.oauthRows.get(plainRowKey('Grant', signIn.grantId));
    if (grant?.model !== 'Grant' || grant.accountId !== signIn.user.userId) return false;
    const key = plainRowKey('SignIn', signIn.grantId);
    this.oauthRows.delete(key); // a re-stage starts a new row
    this.putOAuthRow(
      {
        key,
        model: 'SignIn',
        payload: signInPayload(signIn.user),
        grantId: signIn.grantId,
        accountId: signIn.user.userId,
        clientId: grant.clientId,
        uid: undefined,
        expiresAt: signIn.expiresAt,
      },
      Date.now()
    );
    return true;
  }

  async findOAuthRow(key: string): Promise<OAuthRowRecord | undefined> {
    const row = this.oauthRows.get(key);
    if (!row) return undefined;
    if (GRANT_TOKEN_MODELS.has(row.model)) {
      if (row.grantId === undefined || this.oauthRows.get(plainRowKey('Grant', row.grantId))?.model !== 'Grant') {
        return undefined;
      }
      if (row.accountId === undefined || !this.userHolds(row.accountId, row.createdAt)) return undefined;
    }
    return { ...row };
  }

  async findOAuthRowByUid(uid: string): Promise<OAuthRowRecord | undefined> {
    let newest: OAuthRowRecord | undefined;
    for (const row of this.oauthRows.values()) {
      if (row.model !== 'Session' || row.uid !== uid) continue;
      if (!newest || row.createdAt >= newest.createdAt) newest = row;
    }
    return newest && { ...newest };
  }

  async consumeOAuthRow(key: string): Promise<ConsumeOutcome> {
    const row = this.oauthRows.get(key);
    if (!row) return 'missing';
    if (!CONSUMABLE_MODELS.has(row.model)) throw new Error(`consumeOAuthRow cannot consume a ${row.model} row`);
    if (row.consumedAt === undefined) {
      row.consumedAt = Date.now();
      return 'consumed';
    }
    // Lost the compare-and-set: someone consumed it first. That is reuse.
    if (row.grantId !== undefined) this.revokeGrantSync(row.grantId);
    else this.oauthRows.delete(key);
    return 'replayed';
  }

  async destroyOAuthRow(key: string): Promise<void> {
    this.oauthRows.delete(key);
  }

  async revokeOAuthGrantTokens(grantId: string): Promise<number> {
    let n = 0;
    for (const [key, row] of this.oauthRows) {
      if (row.grantId !== grantId) continue;
      if (!GRANT_TOKEN_MODELS.has(row.model) && row.model !== 'SignIn') continue;
      this.oauthRows.delete(key);
      n++;
    }
    return n;
  }

  async revokeOAuthGrant(grantId: string): Promise<number> {
    return this.revokeGrantSync(grantId);
  }

  /** Every row of a grant, its Grant row included. */
  private revokeGrantSync(grantId: string): number {
    let n = 0;
    for (const [key, row] of this.oauthRows) {
      if (row.grantId === grantId) {
        this.oauthRows.delete(key);
        n++;
      }
    }
    return n;
  }

  /** The grant row a grant-bound row names, when it exists for the same account and client. */
  private liveGrantFor(row: OAuthRowWrite): boolean {
    if (row.grantId === undefined) return false;
    const grant = this.oauthRows.get(plainRowKey('Grant', row.grantId));
    return grant?.model === 'Grant' && grant.accountId === row.accountId && grant.clientId === row.clientId;
  }

  /** Insert or update; an update keeps created_at, consumed_at and authorized_at. */
  private putOAuthRow(row: OAuthRowWrite, now: number): void {
    const existing = this.oauthRows.get(row.key);
    this.oauthRows.set(row.key, {
      key: row.key,
      model: row.model,
      payload: row.payload,
      grantId: row.grantId,
      accountId: row.accountId,
      clientId: row.clientId,
      uid: row.uid,
      expiresAt: row.expiresAt,
      consumedAt: existing?.consumedAt,
      createdAt: existing?.createdAt ?? now,
      authorizedAt: existing?.authorizedAt,
    });
  }

  async sweepExpired(options: SweepOptions = {}): Promise<SweepResult> {
    const now = options.now ?? Date.now();
    const deleted = emptySweepCounts();
    const sweep = <T>(map: Map<string, T>, dead: (value: T) => boolean): number => {
      let n = 0;
      for (const [key, value] of map) {
        if (dead(value)) {
          map.delete(key);
          n++;
        }
      }
      return n;
    };
    deleted.pendingAuth = sweep(this.pending, (r) => r.expiresAt < now);
    deleted.authCodes = sweep(this.authCodes, (r) => r.expiresAt < now);
    deleted.accessTokens = sweep(this.accessTokens, (s) => s.rec.expiresAt < now);
    deleted.refreshTokens = sweep(this.refreshTokens, (s) =>
      refreshTokenExpired(s.issuedAt, s.familyCreatedAt, this.retention, now)
    );
    deleted.consumedRefreshTokens = sweep(this.consumedRefreshTokens, (s) => s.rec.expiresAt < now);
    deleted.consumedAuthCodes = sweep(this.consumedAuthCodes, (r) => r.expiresAt < now);
    deleted.orphanTokens =
      sweep(this.accessTokens, (s) => !this.userHolds(s.rec.userId, s.issuedAt)) +
      sweep(this.refreshTokens, (s) => !this.userHolds(s.rec.userId, s.issuedAt));
    // As CLIENT_HAS_NO_GRANT in retention.ts: nothing in flight, no tokens, and
    // not seen at the YNAB callback within the abandoned-registration window.
    const idle = (c: StoredClient): boolean => {
      const clientId = c.client.client_id;
      if (c.lastSeenAt !== undefined && c.lastSeenAt >= now - this.retention.abandonedClientMs) return false;
      return !(
        [this.pending, this.authCodes, this.consumedAuthCodes].some((m) =>
          [...m.values()].some((r) => r.clientId === clientId)
        ) ||
        [this.accessTokens, this.refreshTokens].some((m) => [...m.values()].some((s) => s.rec.clientId === clientId))
      );
    };
    deleted.abandonedClients = sweep(
      this.clients,
      (c) => c.lastAuthorizedAt === undefined && c.createdAt < now - this.retention.abandonedClientMs && idle(c)
    );
    deleted.unusedClients = sweep(
      this.clients,
      (c) => c.lastAuthorizedAt !== undefined && c.lastAuthorizedAt < now - this.retention.unusedClientMs && idle(c)
    );
    this.sweepOAuthRows(now, deleted, sweep);
    return { ran: true, deleted };
  }

  /** The oauth_rows rules, in the order and with the meaning of retention.ts's SQL. */
  private sweepOAuthRows(
    now: number,
    deleted: SweepResult['deleted'],
    sweep: <T>(map: Map<string, T>, dead: (value: T) => boolean) => number
  ): void {
    const rows = this.oauthRows;
    const has = (pred: (r: OAuthRowRecord) => boolean): boolean => [...rows.values()].some(pred);
    deleted.oauthExpired = sweep(
      rows,
      (r) => r.expiresAt !== undefined && r.expiresAt < now && r.consumedAt === undefined && r.model !== 'Grant'
    );
    deleted.oauthConsumed = sweep(
      rows,
      (r) =>
        r.consumedAt !== undefined &&
        r.consumedAt < now - CONSUMED_CREDENTIAL_RETENTION_MS &&
        !has(
          (l) =>
            l.grantId !== undefined &&
            l.grantId === r.grantId &&
            GRANT_TOKEN_MODELS.has(l.model) &&
            l.consumedAt === undefined &&
            l.expiresAt !== undefined &&
            l.expiresAt >= now
        )
    );
    deleted.oauthOrphans = sweep(
      rows,
      (t) =>
        GRANT_TOKEN_MODELS.has(t.model) &&
        (t.accountId === undefined ||
          !this.userHolds(t.accountId, t.createdAt) ||
          !has((g) => g.model === 'Grant' && g.grantId !== undefined && g.grantId === t.grantId))
    );
    deleted.oauthGrants = sweep(
      rows,
      (g) =>
        g.model === 'Grant' &&
        g.expiresAt !== undefined &&
        g.expiresAt < now &&
        !has((r) => r.model !== 'Grant' && r.grantId !== undefined && r.grantId === g.grantId)
    );
    const idle = (c: OAuthRowRecord): boolean =>
      !has(
        (r) =>
          r.model !== 'Client' &&
          r.model !== 'RegistrationAccessToken' &&
          r.clientId !== undefined &&
          r.clientId === c.clientId
      );
    deleted.oauthAbandonedClients = sweep(
      rows,
      (c) =>
        c.model === 'Client' &&
        c.authorizedAt === undefined &&
        c.createdAt < now - this.retention.abandonedClientMs &&
        idle(c)
    );
    deleted.oauthUnusedClients = sweep(
      rows,
      (c) =>
        c.model === 'Client' &&
        c.authorizedAt !== undefined &&
        c.authorizedAt < now - this.retention.unusedClientMs &&
        idle(c)
    );
    deleted.oauthOrphans += sweep(
      rows,
      (t) =>
        t.model === 'RegistrationAccessToken' &&
        !has((c) => c.model === 'Client' && c.clientId !== undefined && c.clientId === t.clientId)
    );
  }

  /** The account-generation invariant: the user row exists and is not newer than the token. */
  private userHolds(userId: string, issuedAt: number): boolean {
    const user = this.users.get(userId);
    return user !== undefined && issuedUnderUser(issuedAt, user.createdAt);
  }

  private liveRefreshToken(stored: StoredRefreshToken, now: number): boolean {
    return (
      this.userHolds(stored.rec.userId, stored.issuedAt) &&
      !refreshTokenExpired(stored.issuedAt, stored.familyCreatedAt, this.retention, now)
    );
  }

  private deleteFamilySync(familyId: string): void {
    for (const [key, { rec }] of this.accessTokens) {
      if (rec.familyId === familyId) this.accessTokens.delete(key);
    }
    for (const [key, { rec }] of this.refreshTokens) {
      if (rec.familyId === familyId) this.refreshTokens.delete(key);
    }
  }
}
