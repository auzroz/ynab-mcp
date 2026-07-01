/**
 * In-memory storage adapter (zero dependencies).
 *
 * The default driver: works out of the box for single-node / development and is
 * the target for the test suite. NOTE: state is lost on restart — use the SQLite
 * or Postgres driver for durable multi-user deployments.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  Storage,
  UserRecord,
  AuthCodeRecord,
  AccessTokenRecord,
  RefreshTokenRecord,
  PendingAuthRecord,
} from './types.js';

export class MemoryStorage implements Storage {
  private users = new Map<string, UserRecord>();
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, PendingAuthRecord>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();

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
  }

  async upsertUser(rec: UserRecord): Promise<void> {
    this.users.set(rec.userId, rec);
  }
  async getUser(userId: string): Promise<UserRecord | undefined> {
    return this.users.get(userId);
  }
  async deleteUser(userId: string): Promise<void> {
    this.users.delete(userId);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }
  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    this.clients.set(client.client_id, client);
  }

  async savePendingAuth(rec: PendingAuthRecord): Promise<void> {
    this.pending.set(rec.state, rec);
  }
  async takePendingAuth(state: string): Promise<PendingAuthRecord | undefined> {
    const rec = this.pending.get(state);
    this.pending.delete(state);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return rec;
  }

  async saveAuthCode(rec: AuthCodeRecord): Promise<void> {
    this.authCodes.set(rec.code, rec);
  }
  async takeAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
    const rec = this.authCodes.get(code);
    this.authCodes.delete(code);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return rec;
  }

  async saveAccessToken(rec: AccessTokenRecord): Promise<void> {
    this.accessTokens.set(rec.token, rec);
  }
  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const rec = this.accessTokens.get(token);
    if (rec && rec.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      return undefined;
    }
    return rec;
  }
  async deleteAccessToken(token: string): Promise<void> {
    this.accessTokens.delete(token);
  }

  async saveRefreshToken(rec: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(rec.token, rec);
  }
  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const rec = this.refreshTokens.get(token);
    this.refreshTokens.delete(token);
    return rec;
  }
  async deleteRefreshToken(token: string): Promise<void> {
    this.refreshTokens.delete(token);
  }
}
