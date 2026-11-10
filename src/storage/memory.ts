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

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
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
} from './types.js';
import { parseGrantedScope, parseOptionalGrantedScope } from '../auth/scope.js';
import { retentionPolicy, type RetentionPolicy } from '../auth/retention-defaults.js';
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
}

interface StoredConsumedRefreshToken {
  rec: ConsumedRefreshTokenRecord;
  userId: string;
}

export class MemoryStorage implements Storage {
  private users = new Map<string, UserRecord>();
  private clients = new Map<string, StoredClient>();
  private pending = new Map<string, PendingAuthRecord>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private accessTokens = new Map<string, StoredAccessToken>();
  private refreshTokens = new Map<string, StoredRefreshToken>();
  private consumedRefreshTokens = new Map<string, StoredConsumedRefreshToken>();
  private consumedAuthCodes = new Map<string, ConsumedAuthCodeRecord>();
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
  }

  // Users + YNAB tokens

  async upsertUser(rec: UserRecord): Promise<void> {
    // created_at is set by the insert only, from the storage clock.
    const existing = this.users.get(rec.userId);
    this.users.set(rec.userId, { ...rec, createdAt: existing ? existing.createdAt : Date.now() });
  }
  async getUser(userId: string): Promise<UserRecord | undefined> {
    const rec = this.users.get(userId);
    return rec && { ...rec, grantedScope: parseGrantedScope(rec.grantedScope) };
  }
  async updateUserRefreshToken(userId: string, oldCiphertext: string, newCiphertext: string): Promise<boolean> {
    const rec = this.users.get(userId);
    if (!rec || rec.encryptedRefreshToken !== oldCiphertext) return false;
    this.users.set(userId, { ...rec, encryptedRefreshToken: newCiphertext, updatedAt: Date.now() });
    return true;
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
    for (const [key, stored] of this.consumedRefreshTokens) {
      if (stored.userId === userId || families.has(stored.rec.familyId)) this.consumedRefreshTokens.delete(key);
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
    return connectionsFromRows(rows, this.retention, Date.now());
  }

  async revokeUserFamily(userId: string, familyId: string): Promise<boolean> {
    return this.revokeWhere((rec) => rec.userId === userId && rec.familyId === familyId) > 0;
  }

  async deleteTokenFamiliesForClient(userId: string, clientId: string): Promise<number> {
    return this.revokeWhere((rec) => rec.userId === userId && rec.clientId === clientId);
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
    });
  }

  async savePendingAuth(rec: PendingAuthRecord): Promise<void> {
    this.pending.set(rec.state, rec);
  }
  async takePendingAuth(state: string): Promise<PendingAuthRecord | undefined> {
    const rec = this.pending.get(state);
    this.pending.delete(state);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return { ...rec, grantedScope: parseGrantedScope(rec.grantedScope) };
  }

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    this.authCodes.set(rec.code, rec);
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
    const hasGrant = (clientId: string): boolean =>
      [this.pending, this.authCodes].some((m) => [...m.values()].some((r) => r.clientId === clientId)) ||
      [this.accessTokens, this.refreshTokens].some((m) =>
        [...m.values()].some((s) => s.rec.clientId === clientId)
      );
    deleted.abandonedClients = sweep(
      this.clients,
      (c) =>
        c.lastAuthorizedAt === undefined &&
        c.createdAt < now - this.retention.abandonedClientMs &&
        !hasGrant(c.client.client_id)
    );
    deleted.unusedClients = sweep(
      this.clients,
      (c) =>
        c.lastAuthorizedAt !== undefined &&
        c.lastAuthorizedAt < now - this.retention.unusedClientMs &&
        !hasGrant(c.client.client_id)
    );
    return { ran: true, deleted };
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
