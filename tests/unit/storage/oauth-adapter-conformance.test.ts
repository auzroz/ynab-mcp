/**
 * The oidc-provider adapter's storage contract (ADR-0002 D4, D6, D12, D13),
 * run against every storage driver through src/auth/oidc/adapter.ts:
 *
 *   - #52: `h1.` keys for every credential, no `jti` or client secret at rest,
 *     the shape refusal before any storage read, 0.4.x values unknown;
 *   - #42 / RFC 9700: the compare-and-set consume, the race, grant liveness;
 *   - STOR-1: the issued-under-user join, retention and the sweep;
 *   - #94: the code's upsert as `completeAuthorization`;
 *   - D6: consumed codes and refresh tokens found past expiry;
 *   - deletion and the account tools, both generations;
 *   - the library's own models round-tripping through the adapter.
 *
 * PENDING (#47-1 driver step): SqliteStorage and PostgresStorage don't
 * implement OAuthRowStore yet, so their entries are `it.todo`. The driver step
 * flips ADAPTER_READY for its driver and every case must then pass, Postgres
 * with REQUIRE_DB_TESTS=1 and nothing skipped. M4 (the schema and the client
 * conversion) already runs on both: tests/unit/storage/oauth-rows-migration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import Provider, { errors } from 'oidc-provider';
import { testDrivers, cleanupDrivers, type DriverHandle, type DriverKind, type TestDriver } from '../helpers/storage-drivers.js';
import { TEST_TOKEN_HASHER, legacyToken, testKey } from '../helpers/token-hasher.js';
import {
  ADAPTER_MODELS,
  AuthorizationNotCompletedError,
  createOidcAdapter,
  type OidcAdapter,
} from '../../../src/auth/oidc/adapter.js';
import { CLIENT_SCHEMA_CONFIGURATION, ephemeralSigningKeys } from '../../../src/auth/oidc/client-schema.js';
import { hashClientSecret } from '../../../src/auth/token-hash.js';
import { plainRowKey } from '../../../src/storage/oauth-rows.js';
import { CONSUMED_CREDENTIAL_RETENTION_MS } from '../../../src/auth/retention-defaults.js';
import type { OAuthRowRecord, OAuthRowStore, Storage } from '../../../src/storage/types.js';

/**
 * Which drivers implement OAuthRowStore. #47-1's driver step sets sqlite and
 * postgres to true when SqliteStorage and PostgresStorage implement it.
 */
const ADAPTER_READY: Record<DriverKind, boolean> = { memory: true, sqlite: false, postgres: false };

const R = 'https://mcp.example.com/mcp';
const DAY = 86_400_000;
const REDIRECT = 'https://client.example/cb';

/** A library id: 43 base64url characters, as nanoid makes them. */
const libId = (): string => randomBytes(32).toString('base64url');
const nowSec = (): number => Math.floor(Date.now() / 1000);

type Store = Storage & OAuthRowStore;

interface Ctx {
  handle: DriverHandle;
  store: Store;
  adapter: (model: string) => OidcAdapter;
}

/** One `oauth_rows` row as the database (or the memory map) holds it. */
interface RawRow {
  key: string;
  model: string;
  payload: string;
  grant_id: string | null;
  account_id: string | null;
  client_id: string | null;
  uid: string | null;
  expires_at: number | null;
  consumed_at: number | null;
  created_at: number;
  authorized_at: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function oauthRows(h: DriverHandle): Promise<RawRow[]> {
  if (h.sql) {
    return (await h.sql('SELECT * FROM oauth_rows ORDER BY key')).map((r) => ({
      key: String(r['key']),
      model: String(r['model']),
      payload: String(r['payload']),
      grant_id: (r['grant_id'] as string | null) ?? null,
      account_id: (r['account_id'] as string | null) ?? null,
      client_id: (r['client_id'] as string | null) ?? null,
      uid: (r['uid'] as string | null) ?? null,
      expires_at: num(r['expires_at']),
      consumed_at: num(r['consumed_at']),
      created_at: Number(r['created_at']),
      authorized_at: num(r['authorized_at']),
    }));
  }
  const map = (h.storage as unknown as { oauthRows: Map<string, OAuthRowRecord> }).oauthRows;
  return [...map.values()]
    .map((r) => ({
      key: r.key,
      model: r.model,
      payload: r.payload,
      grant_id: r.grantId ?? null,
      account_id: r.accountId ?? null,
      client_id: r.clientId ?? null,
      uid: r.uid ?? null,
      expires_at: r.expiresAt ?? null,
      consumed_at: r.consumedAt ?? null,
      created_at: r.createdAt,
      authorized_at: r.authorizedAt ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function rowFor(ctx: Ctx, key: string): Promise<RawRow | undefined> {
  return (await oauthRows(ctx.handle)).find((r) => r.key === key);
}

// ---- builders: what the library would hand the adapter -------------------

async function registerClient(ctx: Ctx, extra: Record<string, unknown> = {}): Promise<{ clientId: string; secret: string }> {
  const clientId = libId();
  const secret = randomBytes(64).toString('base64url');
  await ctx.adapter('Client').upsert(clientId, {
    client_id: clientId,
    client_secret: secret,
    client_name: 'Test Client',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'client_secret_post',
    ...extra,
  });
  return { clientId, secret };
}

async function saveGrant(
  ctx: Ctx,
  accountId: string,
  clientId: string,
  opts: { ttlSec?: number; scope?: string; rejected?: string } = {}
): Promise<string> {
  const grantId = libId();
  const ttl = opts.ttlSec ?? 90 * 86_400;
  await ctx.adapter('Grant').upsert(
    grantId,
    {
      kind: 'Grant',
      jti: grantId,
      accountId,
      clientId,
      resources: { [R]: opts.scope ?? 'read-only' },
      ...(opts.rejected ? { rejected: { resources: { [R]: opts.rejected } } } : {}),
      iat: nowSec(),
      exp: nowSec() + ttl,
    },
    ttl
  );
  return grantId;
}

const stage = (ctx: Ctx, grantId: string, userId: string, opts: { ttlMs?: number; scope?: 'read-only' | 'read-write' } = {}) =>
  ctx.store.stageSignIn({
    grantId,
    user: { userId, grantedScope: opts.scope ?? 'read-only', encryptedRefreshToken: `enc-${userId}`, updatedAt: Date.now() },
    expiresAt: Date.now() + (opts.ttlMs ?? 600_000),
  });

interface Refs {
  accountId: string;
  clientId: string;
  grantId: string;
}

function tokenPayload(model: string, id: string, refs: Refs, ttlSec: number): Record<string, unknown> {
  const iat = nowSec();
  return {
    kind: model,
    jti: id,
    accountId: refs.accountId,
    clientId: refs.clientId,
    grantId: refs.grantId,
    iat,
    exp: iat + ttlSec,
    scope: 'read-only',
    ...(model === 'AccessToken' ? { aud: R, gty: 'authorization_code' } : {}),
    ...(model === 'RefreshToken' ? { iiat: iat, rotations: 0, gty: 'authorization_code', resource: R } : {}),
    ...(model === 'AuthorizationCode'
      ? { codeChallenge: 'c'.repeat(43), codeChallengeMethod: 'S256', redirectUri: REDIRECT, resource: R }
      : {}),
  };
}

async function saveToken(ctx: Ctx, model: string, refs: Refs, ttlSec = 3600): Promise<string> {
  const id = libId();
  await ctx.adapter(model).upsert(id, tokenPayload(model, id, refs, ttlSec), ttlSec);
  return id;
}

/** A completed sign-in: client, grant, staged sign-in, and the code whose upsert applied it. */
async function signedIn(ctx: Ctx, userId = `u-${libId().slice(0, 8)}`): Promise<Refs & { code: string; secret: string }> {
  const { clientId, secret } = await registerClient(ctx);
  const grantId = await saveGrant(ctx, userId, clientId);
  expect(await stage(ctx, grantId, userId)).toBe(true);
  const refs = { accountId: userId, clientId, grantId };
  const code = await saveToken(ctx, 'AuthorizationCode', refs, 600);
  return { ...refs, code, secret };
}

/** A store wrapper that records every method called on it. */
function counting(store: Store): { store: Store; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

const adapterOver = (store: OAuthRowStore) => {
  const factory = createOidcAdapter({ store, keys: TEST_TOKEN_HASHER });
  return (model: string) => factory(model) as OidcAdapter;
};

const KIND: Record<string, 'access' | 'refresh' | 'code' | 'session' | 'interaction' | 'registration'> = {
  AccessToken: 'access',
  RefreshToken: 'refresh',
  AuthorizationCode: 'code',
  Session: 'session',
  Interaction: 'interaction',
  RegistrationAccessToken: 'registration',
};

// ---- the cases -------------------------------------------------------------

interface Case {
  name: string;
  run(ctx: Ctx): Promise<void>;
}

const CASES: Case[] = [
  // D4, #52: hashed at rest.
  {
    name: 'D4/#52: keys every credential by the h1 HMAC of its kind and id; no jti, value or client secret is stored',
    async run(ctx) {
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s);
      const rt = await saveToken(ctx, 'RefreshToken', s, 30 * 86_400);
      const session = libId();
      const sessionUid = libId();
      await ctx.adapter('Session').upsert(
        session,
        { kind: 'Session', jti: session, uid: sessionUid, accountId: s.accountId, iat: nowSec(), exp: nowSec() + 600 },
        600
      );
      const interaction = libId();
      await ctx.adapter('Interaction').upsert(
        interaction,
        {
          kind: 'Interaction',
          jti: interaction,
          params: { client_id: s.clientId },
          result: { login: { accountId: s.accountId } },
          iat: nowSec(),
          exp: nowSec() + 600,
        },
        600
      );
      const rat = libId();
      await ctx.adapter('RegistrationAccessToken').upsert(rat, { kind: 'RegistrationAccessToken', jti: rat, clientId: s.clientId, iat: nowSec() });

      const rows = await oauthRows(ctx.handle);
      const dump = JSON.stringify(rows);
      for (const [model, id] of [
        ['AuthorizationCode', s.code],
        ['AccessToken', at],
        ['RefreshToken', rt],
        ['Session', session],
        ['Interaction', interaction],
        ['RegistrationAccessToken', rat],
      ] as const) {
        const key = TEST_TOKEN_HASHER.libraryStorageKey(KIND[model]!, id) as string;
        expect(key).toMatch(/^h1\.[0-9a-f]{64}$/);
        const row = rows.find((r) => r.key === key);
        expect(row?.model).toBe(model);
        expect(JSON.parse(row!.payload)).not.toHaveProperty('jti');
        expect(dump).not.toContain(id);
      }
      expect(dump).not.toContain(s.secret);
      const client = rows.find((r) => r.key === plainRowKey('Client', s.clientId));
      expect(JSON.parse(client!.payload)).toMatchObject({ client_secret_hash: hashClientSecret(s.secret) });
      expect(JSON.parse(client!.payload)).not.toHaveProperty('client_secret');
      // The indexed columns.
      expect(rows.find((r) => r.model === 'Session')).toMatchObject({ uid: sessionUid, account_id: s.accountId });
      expect(rows.find((r) => r.model === 'Interaction')).toMatchObject({ client_id: s.clientId, account_id: s.accountId });
      expect(rows.find((r) => r.model === 'RegistrationAccessToken')).toMatchObject({ client_id: s.clientId, account_id: null });
      expect(rows.find((r) => r.model === 'AccessToken')).toMatchObject({
        grant_id: s.grantId,
        account_id: s.accountId,
        client_id: s.clientId,
      });
    },
  },
  {
    name: 'D4: keys grants and clients by their plain ids',
    async run(ctx) {
      const s = await signedIn(ctx);
      const grant = await rowFor(ctx, plainRowKey('Grant', s.grantId));
      expect(grant).toMatchObject({ model: 'Grant', grant_id: s.grantId, account_id: s.accountId, client_id: s.clientId });
      expect(JSON.parse(grant!.payload)).not.toHaveProperty('jti');
      expect(await rowFor(ctx, plainRowKey('Client', s.clientId))).toMatchObject({ model: 'Client', client_id: s.clientId });
    },
  },
  {
    name: 'D4: find puts jti back, returns consumed from the column, and hands a client its secret hash as client_secret',
    async run(ctx) {
      const s = await signedIn(ctx);
      const found = await ctx.adapter('AuthorizationCode').find(s.code);
      expect(found).toMatchObject({ jti: s.code, accountId: s.accountId, clientId: s.clientId, grantId: s.grantId });
      expect(found).not.toHaveProperty('consumed');
      await ctx.adapter('AuthorizationCode').consume(s.code);
      const consumed = await ctx.adapter('AuthorizationCode').find(s.code);
      expect(consumed?.consumed).toBeGreaterThan(0);
      const client = await ctx.adapter('Client').find(s.clientId);
      expect(client?.client_secret).toBe(hashClientSecret(s.secret));
      expect(client).not.toHaveProperty('client_secret_hash');
      // A re-save of the found client keeps the hash (never hashed twice).
      await ctx.adapter('Client').upsert(s.clientId, client!);
      expect((await ctx.adapter('Client').find(s.clientId))?.client_secret).toBe(hashClientSecret(s.secret));
      expect((await ctx.adapter('Grant').find(s.grantId))?.jti).toBe(s.grantId);
    },
  },
  {
    name: '#52: an id that is not 43 base64url characters is refused before any storage read',
    async run(ctx) {
      const s = await signedIn(ctx);
      const spy = counting(ctx.store);
      const a = adapterOver(spy.store);
      const storedKey = TEST_TOKEN_HASHER.libraryStorageKey('code', s.code) as string;
      for (const bad of ['', 'short', `${s.code}!`, `${s.code}A`, storedKey, `ymcp1_${s.code}_${'a'.repeat(22)}`]) {
        for (const model of ['AccessToken', 'RefreshToken', 'AuthorizationCode', 'Session', 'Interaction', 'Grant']) {
          expect(await a(model).find(bad)).toBeUndefined();
        }
        expect(await a('Session').findByUid(bad)).toBeUndefined();
        await expect(a('RefreshToken').consume(bad)).rejects.toBeInstanceOf(errors.InvalidGrant);
        await a('AccessToken').destroy(bad);
        await a('Grant').destroy(bad);
        await a('AccessToken').revokeByGrantId(bad);
      }
      expect(await a('AccessToken').find(42 as unknown as string)).toBeUndefined();
      // Never coerced to a string: an array of one well-formed id is not that id.
      expect(await a('Grant').find([s.grantId] as unknown as string)).toBeUndefined();
      expect(await a('Client').find([s.clientId] as unknown as string)).toBeUndefined();
      expect(await a('Client').find(42 as unknown as string)).toBeUndefined();
      expect(await a('Session').findByUid([libId()] as unknown as string)).toBeUndefined();
      expect(await a('Client').find('')).toBeUndefined();
      expect(await a('Client').find('x'.repeat(256))).toBeUndefined();
      expect(await a('Session').findByUserCode('ABCD-EFGH')).toBeUndefined();
      expect(spy.calls).toEqual([]);
      // The library generates every id it saves; a malformed one is a bug, refused without a write.
      await expect(a('AccessToken').upsert('short', tokenPayload('AccessToken', 'short', s, 60), 60)).rejects.toThrow();
      expect(spy.calls).toEqual([]);
    },
  },
  {
    name: 'D12: a 0.4.x access token, refresh token or code reads as unknown',
    async run(ctx) {
      const s = await signedIn(ctx);
      const [at, rt, code] = [legacyToken(), legacyToken(), legacyToken()];
      await ctx.store.saveAccessToken({
        token: testKey('access', at),
        clientId: s.clientId,
        userId: s.accountId,
        scopes: ['read-only'],
        expiresAt: Date.now() + 3_600_000,
        familyId: 'legacy-family',
      });
      await ctx.store.saveRefreshToken({
        token: testKey('refresh', rt),
        clientId: s.clientId,
        userId: s.accountId,
        scopes: ['read-only'],
        familyId: 'legacy-family',
      });
      await ctx.store.saveAuthCode({
        code: testKey('code', code),
        clientId: s.clientId,
        userId: s.accountId,
        redirectUri: REDIRECT,
        codeChallenge: 'c'.repeat(43),
        scopes: ['read-only'],
        expiresAt: Date.now() + 600_000,
      });
      // Same shape, same HMAC: only the table differs, and nothing reads the old one.
      expect(TEST_TOKEN_HASHER.libraryStorageKey('access', at)).toBe(testKey('access', at));
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('RefreshToken').find(rt)).toBeUndefined();
      expect(await ctx.adapter('AuthorizationCode').find(code)).toBeUndefined();
      await expect(ctx.adapter('RefreshToken').consume(rt)).rejects.toBeInstanceOf(errors.InvalidGrant);
    },
  },
  {
    name: 'D2: a model of a disabled feature is refused',
    async run(ctx) {
      for (const model of ['DeviceCode', 'BackchannelAuthenticationRequest', 'ClientCredentials', 'PushedAuthorizationRequest', 'ReplayDetection', 'InitialAccessToken', 'SignIn', 'constructor']) {
        expect(() => ctx.adapter(model)).toThrow(/not supported/);
      }
      expect([...ADAPTER_MODELS].sort()).toEqual(
        ['AccessToken', 'AuthorizationCode', 'Client', 'Grant', 'Interaction', 'RefreshToken', 'RegistrationAccessToken', 'Session'].sort()
      );
      await expect(ctx.adapter('AccessToken').consume(libId())).rejects.toThrow(/not consumable/);
    },
  },
  {
    name: 'D4: a session is found by its uid, without its id (a credential stored only as its key)',
    async run(ctx) {
      const session = libId();
      const uid = libId();
      await ctx.adapter('Session').upsert(session, { kind: 'Session', jti: session, uid, accountId: 'u1', iat: nowSec(), exp: nowSec() + 600 }, 600);
      const found = await ctx.adapter('Session').findByUid(uid);
      expect(found).toMatchObject({ uid, accountId: 'u1' });
      expect(found).not.toHaveProperty('jti');
      expect(await ctx.adapter('Session').findByUid(libId())).toBeUndefined();
      expect(await ctx.adapter('Interaction').findByUid(uid)).toBeUndefined();
      expect((await ctx.adapter('Session').find(session))?.jti).toBe(session);
      await ctx.adapter('Session').destroy(session);
      expect(await ctx.adapter('Session').find(session)).toBeUndefined();
      expect(await ctx.adapter('Session').findByUid(uid)).toBeUndefined();
    },
  },

  // #42, RFC 9700: the compare-and-set consume.
  {
    name: '#42: a second consume of a code revokes its whole grant and throws the library\'s InvalidGrant',
    async run(ctx) {
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s);
      const rt = await saveToken(ctx, 'RefreshToken', s, 86_400);
      await ctx.adapter('AuthorizationCode').consume(s.code);
      await expect(ctx.adapter('AuthorizationCode').consume(s.code)).rejects.toBeInstanceOf(errors.InvalidGrant);
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('RefreshToken').find(rt)).toBeUndefined();
      expect(await ctx.adapter('Grant').find(s.grantId)).toBeUndefined();
      expect((await oauthRows(ctx.handle)).filter((r) => r.grant_id === s.grantId)).toEqual([]);
    },
  },
  {
    name: 'RFC 9700: a second consume of a refresh token revokes the grant; consuming a missing row throws',
    async run(ctx) {
      const s = await signedIn(ctx);
      const rt = await saveToken(ctx, 'RefreshToken', s, 86_400);
      await ctx.adapter('RefreshToken').consume(rt);
      const next = await saveToken(ctx, 'RefreshToken', s, 86_400); // the rotation's successor
      await expect(ctx.adapter('RefreshToken').consume(rt)).rejects.toBeInstanceOf(errors.InvalidGrant);
      expect(await ctx.adapter('RefreshToken').find(next)).toBeUndefined();
      await expect(ctx.adapter('RefreshToken').consume(libId())).rejects.toBeInstanceOf(errors.InvalidGrant);
    },
  },
  {
    name: 'RFC 9700: the forced race. Of two consumes of one refresh token one wins, the loser revokes the grant, and the winner\'s successor is refused',
    async run(ctx) {
      const s = await signedIn(ctx);
      const rt = await saveToken(ctx, 'RefreshToken', s, 86_400);
      // Two replicas: a second storage on the same database (memory: the same one).
      const second = adapterOver((await ctx.handle.reopen()) as Store);
      const results = await Promise.allSettled([ctx.adapter('RefreshToken').consume(rt), second('RefreshToken').consume(rt)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(errors.InvalidGrant);
      // The winner goes on to save the rotated pair: the grant is gone, so nothing is saved.
      await expect(saveToken(ctx, 'RefreshToken', s, 86_400)).rejects.toBeInstanceOf(errors.InvalidGrant);
      await expect(saveToken(ctx, 'AccessToken', s)).rejects.toBeInstanceOf(errors.InvalidGrant);
      expect((await oauthRows(ctx.handle)).filter((r) => r.grant_id === s.grantId)).toEqual([]);
    },
  },
  {
    name: '#42: two concurrent redemptions of one code leave no live token',
    async run(ctx) {
      const s = await signedIn(ctx);
      const second = adapterOver((await ctx.handle.reopen()) as Store);
      const redeem = async (a: (m: string) => OidcAdapter): Promise<void> => {
        await a('AuthorizationCode').consume(s.code);
        const id = libId();
        await a('AccessToken').upsert(id, tokenPayload('AccessToken', id, s, 3600), 3600);
      };
      const results = await Promise.allSettled([redeem(ctx.adapter), redeem(second)]);
      expect(results.some((r) => r.status === 'rejected')).toBe(true);
      const live = (await oauthRows(ctx.handle)).filter((r) => r.grant_id === s.grantId && r.model === 'AccessToken');
      for (const row of live) expect(await ctx.store.findOAuthRow(row.key)).toBeUndefined();
    },
  },

  // #42: tokens only for a live grant.
  {
    name: '#42: a token is saved only while its grant row exists for the same account and client',
    async run(ctx) {
      const s = await signedIn(ctx);
      const other = await registerClient(ctx);
      await expect(saveToken(ctx, 'AccessToken', { ...s, clientId: other.clientId })).rejects.toBeInstanceOf(errors.InvalidGrant);
      await expect(saveToken(ctx, 'AccessToken', { ...s, accountId: 'someone-else' })).rejects.toBeInstanceOf(errors.InvalidGrant);
      await expect(saveToken(ctx, 'RefreshToken', { ...s, grantId: libId() })).rejects.toBeInstanceOf(errors.InvalidGrant);
      await ctx.adapter('Grant').destroy(s.grantId);
      await expect(saveToken(ctx, 'AccessToken', s)).rejects.toBeInstanceOf(errors.InvalidGrant);
      expect((await oauthRows(ctx.handle)).filter((r) => r.model === 'AccessToken' || r.model === 'RefreshToken')).toEqual([]);
      // A token without its grant, account or client is a bug: refused before storage.
      const id = libId();
      const { grantId: _g, ...noGrant } = tokenPayload('AccessToken', id, s, 60);
      await expect(ctx.adapter('AccessToken').upsert(id, noGrant, 60)).rejects.toThrow(/without its grant/);
    },
  },
  {
    name: '#42: a token reads as unknown once its grant row is gone, even while its own row remains',
    async run(ctx) {
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s);
      const rt = await saveToken(ctx, 'RefreshToken', s, 86_400);
      // As when a revocation lands between a token's save and the library's grant destroy.
      await ctx.store.destroyOAuthRow(plainRowKey('Grant', s.grantId));
      expect(await rowFor(ctx, TEST_TOKEN_HASHER.libraryStorageKey('access', at) as string)).toBeDefined();
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('RefreshToken').find(rt)).toBeUndefined();
      expect(await ctx.adapter('AuthorizationCode').find(s.code)).toBeUndefined();
    },
  },
  {
    name: 'D4: revokeByGrantId deletes the grant\'s tokens and codes, live or consumed, and keeps the Grant row; destroying the grant deletes everything',
    async run(ctx) {
      const s = await signedIn(ctx);
      const other = await signedIn(ctx, s.accountId);
      await ctx.adapter('AuthorizationCode').consume(s.code);
      const at = await saveToken(ctx, 'AccessToken', s);
      const rt = await saveToken(ctx, 'RefreshToken', s, 86_400);
      await ctx.adapter('RefreshToken').revokeByGrantId(s.grantId);
      for (const [model, id] of [['AccessToken', at], ['RefreshToken', rt], ['AuthorizationCode', s.code]] as const) {
        expect(await ctx.adapter(model).find(id)).toBeUndefined();
      }
      expect(await ctx.adapter('Grant').find(s.grantId)).toBeDefined();
      expect(await ctx.adapter('AuthorizationCode').find(other.code)).toBeDefined();
      await ctx.adapter('AccessToken').revokeByGrantId(s.grantId); // idempotent (the library calls it per model)
      await ctx.adapter('Grant').destroy(s.grantId);
      expect((await oauthRows(ctx.handle)).filter((r) => r.grant_id === s.grantId)).toEqual([]);
      expect(await ctx.adapter('Grant').find(other.grantId)).toBeDefined();
    },
  },

  // STOR-1: the issued-under-user join.
  {
    name: 'STOR-1: a token or code reads as unknown once its user row is gone',
    async run(ctx) {
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s);
      await ctx.store.deleteUser(s.accountId);
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('AuthorizationCode').find(s.code)).toBeUndefined();
      await expect(saveToken(ctx, 'AccessToken', s)).rejects.toBeInstanceOf(errors.InvalidGrant);
    },
  },
  {
    name: 'STOR-1: a token issued before its user row was re-created reads as unknown (spike 45, 46)',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s);
      const rt = await saveToken(ctx, 'RefreshToken', s, 86_400);
      vi.setSystemTime(T + 1000);
      await ctx.store.deleteUser(s.accountId);
      vi.setSystemTime(T + 2000);
      await ctx.store.upsertUser({ userId: s.accountId, grantedScope: 'read-only', encryptedRefreshToken: 'new', updatedAt: Date.now() });
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('RefreshToken').find(rt)).toBeUndefined();
      expect(await ctx.adapter('AuthorizationCode').find(s.code)).toBeUndefined();
      // A token issued under the new row reads.
      const fresh = await saveToken(ctx, 'AccessToken', s);
      expect(await ctx.adapter('AccessToken').find(fresh)).toBeDefined();
    },
  },

  // #94: the code's upsert is completeAuthorization.
  {
    name: '#94: the code\'s upsert applies the staged sign-in, stamps the client and inserts the code in one step',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const { clientId } = await registerClient(ctx);
      const grantId = await saveGrant(ctx, 'u1', clientId);
      expect(await stage(ctx, grantId, 'u1', { scope: 'read-write' })).toBe(true);
      expect(await ctx.store.getUser('u1')).toBeUndefined(); // staged, not applied
      vi.setSystemTime(T + 5000);
      const code = await saveToken(ctx, 'AuthorizationCode', { accountId: 'u1', clientId, grantId }, 600);
      const user = await ctx.store.getUser('u1');
      expect(user).toMatchObject({ userId: 'u1', grantedScope: 'read-write', encryptedRefreshToken: 'enc-u1', createdAt: T + 5000 });
      expect(await rowFor(ctx, plainRowKey('SignIn', grantId))).toBeUndefined();
      expect((await rowFor(ctx, plainRowKey('Client', clientId)))?.authorized_at).toBe(T + 5000);
      const row = await rowFor(ctx, TEST_TOKEN_HASHER.libraryStorageKey('code', code) as string);
      expect(row?.created_at).toBe(T + 5000);
      expect(await ctx.adapter('AuthorizationCode').find(code)).toBeDefined();
      // A returning user keeps the row's generation; the new grant level is applied.
      vi.setSystemTime(T + 9000);
      const again = await saveGrant(ctx, 'u1', clientId);
      expect(await stage(ctx, again, 'u1', { scope: 'read-only' })).toBe(true);
      await saveToken(ctx, 'AuthorizationCode', { accountId: 'u1', clientId, grantId: again }, 600);
      expect(await ctx.store.getUser('u1')).toMatchObject({ grantedScope: 'read-only', createdAt: T + 5000 });
      expect(await ctx.adapter('AuthorizationCode').find(code)).toBeDefined();
    },
  },
  {
    name: '#94: a code for a removed client, a revoked grant or without a live staged sign-in writes nothing (server_error)',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const expectRefused = async (refs: Refs, reason: string): Promise<void> => {
        const before = await oauthRows(ctx.handle);
        const err = await saveToken(ctx, 'AuthorizationCode', refs, 600).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AuthorizationNotCompletedError);
        expect(err).not.toBeInstanceOf(errors.OIDCProviderError); // the library answers server_error
        expect((err as AuthorizationNotCompletedError).reason).toBe(reason);
        expect(await oauthRows(ctx.handle)).toEqual(before);
        expect(await ctx.store.getUser(refs.accountId)).toBeUndefined();
      };
      // The client is gone (the sweep removed it).
      const gone = await registerClient(ctx);
      const g1 = await saveGrant(ctx, 'u1', gone.clientId);
      await stage(ctx, g1, 'u1');
      await ctx.store.destroyOAuthRow(plainRowKey('Client', gone.clientId));
      await expectRefused({ accountId: 'u1', clientId: gone.clientId, grantId: g1 }, 'client-gone');
      // The grant was revoked meanwhile.
      const { clientId } = await registerClient(ctx);
      const g2 = await saveGrant(ctx, 'u1', clientId);
      await stage(ctx, g2, 'u1');
      await ctx.store.revokeOAuthGrant(g2);
      await expectRefused({ accountId: 'u1', clientId, grantId: g2 }, 'grant-gone');
      // Nothing was staged, or the staged sign-in is for someone else or has expired.
      const g3 = await saveGrant(ctx, 'u1', clientId);
      await expectRefused({ accountId: 'u1', clientId, grantId: g3 }, 'no-sign-in');
      const g4 = await saveGrant(ctx, 'u1', clientId);
      await stage(ctx, g4, 'u1', { ttlMs: 1000 });
      vi.setSystemTime(Date.now() + 2000);
      await expectRefused({ accountId: 'u1', clientId, grantId: g4 }, 'no-sign-in');
      // stageSignIn itself needs the grant, for that account.
      expect(await stage(ctx, libId(), 'u1')).toBe(false);
      const g5 = await saveGrant(ctx, 'u2', clientId);
      expect(await stage(ctx, g5, 'u1')).toBe(false);
    },
  },

  // D6: retention and expiry on read.
  {
    name: 'D6: codes, refresh tokens and grants are found past expiry, consumed or not; every other model is not',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s, 60);
      const rt = await saveToken(ctx, 'RefreshToken', s, 60);
      const live = await saveToken(ctx, 'RefreshToken', s, 60);
      await ctx.adapter('AuthorizationCode').consume(s.code);
      await ctx.adapter('RefreshToken').consume(rt);
      const session = libId();
      await ctx.adapter('Session').upsert(session, { kind: 'Session', jti: session, uid: libId(), accountId: s.accountId, exp: nowSec() + 60 }, 60);
      const interaction = libId();
      await ctx.adapter('Interaction').upsert(interaction, { kind: 'Interaction', jti: interaction, params: {}, exp: nowSec() + 60 }, 60);
      vi.setSystemTime(T + 10 * DAY);
      // grant-guard's lookups (ignoreExpiration): a consumed, expired code and refresh token are still there.
      expect((await ctx.adapter('AuthorizationCode').find(s.code))?.consumed).toBeTruthy();
      expect((await ctx.adapter('RefreshToken').find(rt))?.consumed).toBeTruthy();
      expect(await ctx.adapter('RefreshToken').find(live)).toBeDefined();
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('Session').find(session)).toBeUndefined();
      expect(await ctx.adapter('Interaction').find(interaction)).toBeUndefined();
      vi.setSystemTime(T + 100 * DAY);
      expect(await ctx.adapter('Grant').find(s.grantId)).toBeDefined(); // the library checks a grant's expiry itself
    },
  },

  // The sweep (STOR-1 retention, D6).
  {
    name: 'D6 sweep: expired unconsumed rows go at once; consumed ones stay 30 days, and longer while the grant has a live token',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const s = await signedIn(ctx);
      const at = await saveToken(ctx, 'AccessToken', s, 3600);
      const rt = await saveToken(ctx, 'RefreshToken', s, 60 * 86_400);
      const unused = await saveToken(ctx, 'RefreshToken', s, 3600);
      await ctx.adapter('AuthorizationCode').consume(s.code);
      const session = libId();
      await ctx.adapter('Session').upsert(session, { kind: 'Session', jti: session, uid: libId(), accountId: s.accountId, exp: nowSec() + 600 }, 600);
      const interaction = libId();
      await ctx.adapter('Interaction').upsert(interaction, { kind: 'Interaction', jti: interaction, params: { client_id: s.clientId }, exp: nowSec() + 600 }, 600);
      const late = await registerClient(ctx);
      const staged = await saveGrant(ctx, s.accountId, late.clientId, { ttlSec: 120 * 86_400 });
      await stage(ctx, staged, s.accountId, { ttlMs: 600_000 });

      vi.setSystemTime(T + 2 * 3_600_000);
      let swept = await ctx.store.sweepExpired();
      // The access token, the never-used refresh token, the session, the interaction, the staged sign-in.
      expect(swept.deleted.oauthExpired).toBe(5);
      expect(swept.deleted.oauthConsumed).toBe(0);
      expect(await ctx.adapter('AccessToken').find(at)).toBeUndefined();
      expect(await ctx.adapter('RefreshToken').find(unused)).toBeUndefined();
      expect(await rowFor(ctx, plainRowKey('SignIn', staged))).toBeUndefined();
      expect((await ctx.adapter('AuthorizationCode').find(s.code))?.consumed).toBeTruthy();

      vi.setSystemTime(T + 31 * DAY); // past the 30 days, but the refresh token lives until day 60
      swept = await ctx.store.sweepExpired();
      expect(swept.deleted.oauthConsumed).toBe(0);
      expect(await ctx.adapter('AuthorizationCode').find(s.code)).toBeDefined();

      vi.setSystemTime(T + 61 * DAY);
      swept = await ctx.store.sweepExpired();
      expect(swept.deleted.oauthExpired).toBe(1); // the refresh token
      expect(swept.deleted.oauthConsumed).toBe(1); // then the code: no live token left
      expect(await ctx.adapter('AuthorizationCode').find(s.code)).toBeUndefined();
      expect(swept.deleted.oauthGrants).toBe(0); // the grant lives until day 90
      expect(await ctx.adapter('RefreshToken').find(rt)).toBeUndefined();

      vi.setSystemTime(T + 91 * DAY);
      swept = await ctx.store.sweepExpired();
      expect(swept.deleted.oauthGrants).toBe(1);
      expect(await ctx.adapter('Grant').find(s.grantId)).toBeUndefined();
      expect(await ctx.adapter('Grant').find(staged)).toBeDefined(); // day 120
      const again = await ctx.store.sweepExpired();
      expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    },
  },
  {
    name: 'D6 sweep: a consumed row past 30 days goes when its grant has no live token',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const s = await signedIn(ctx);
      const rt = await saveToken(ctx, 'RefreshToken', s, 10 * 86_400);
      await ctx.adapter('AuthorizationCode').consume(s.code);
      await ctx.adapter('RefreshToken').consume(rt);
      vi.setSystemTime(T + CONSUMED_CREDENTIAL_RETENTION_MS - 1000);
      expect((await ctx.store.sweepExpired()).deleted.oauthConsumed).toBe(0);
      vi.setSystemTime(T + CONSUMED_CREDENTIAL_RETENTION_MS + 1000);
      expect((await ctx.store.sweepExpired()).deleted.oauthConsumed).toBe(2);
    },
  },
  {
    name: 'STOR-1 sweep: grant-bound rows whose grant or user is gone, and registration tokens of removed clients',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const a = await signedIn(ctx);
      await saveToken(ctx, 'AccessToken', a);
      await saveToken(ctx, 'RefreshToken', a, 86_400);
      await ctx.store.destroyOAuthRow(plainRowKey('Grant', a.grantId)); // grant row gone: code + 2 tokens
      const b = await signedIn(ctx);
      await saveToken(ctx, 'AccessToken', b);
      vi.setSystemTime(T + 1000);
      await ctx.store.deleteUser(b.accountId); // user gone: code + token
      const c = await signedIn(ctx);
      await saveToken(ctx, 'AccessToken', c);
      vi.setSystemTime(T + 2000);
      await ctx.store.deleteUser(c.accountId);
      vi.setSystemTime(T + 3000);
      await ctx.store.upsertUser({ userId: c.accountId, grantedScope: 'read-only', encryptedRefreshToken: 'x', updatedAt: Date.now() }); // newer: code + token
      const rat = libId();
      await ctx.adapter('RegistrationAccessToken').upsert(rat, { kind: 'RegistrationAccessToken', jti: rat, clientId: a.clientId });
      await ctx.store.destroyOAuthRow(plainRowKey('Client', a.clientId));
      const kept = await signedIn(ctx);
      const keptToken = await saveToken(ctx, 'AccessToken', kept);
      const swept = await ctx.store.sweepExpired();
      expect(swept.deleted.oauthOrphans).toBe(3 + 2 + 2 + 1);
      expect(await ctx.adapter('AccessToken').find(keptToken)).toBeDefined();
      expect(await ctx.adapter('AuthorizationCode').find(kept.code)).toBeDefined();
    },
  },
  {
    name: 'STOR-1 sweep: library clients by the abandoned and unused windows; a client in flight or signed in recently stays',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const abandoned = await registerClient(ctx);
      const inFlight = await registerClient(ctx);
      const unused = await signedIn(ctx); // authorized at T; its grant expires at T + 90 days
      const rat = libId();
      await ctx.adapter('RegistrationAccessToken').upsert(rat, { kind: 'RegistrationAccessToken', jti: rat, clientId: abandoned.clientId });

      vi.setSystemTime(T + 25 * 3_600_000);
      const interaction = libId();
      await ctx.adapter('Interaction').upsert(interaction, { kind: 'Interaction', jti: interaction, params: { client_id: inFlight.clientId }, exp: nowSec() + 600 }, 600);
      let swept = await ctx.store.sweepExpired();
      expect(swept.deleted.oauthAbandonedClients).toBe(1);
      expect(swept.deleted.oauthOrphans).toBe(1); // its registration access token
      expect(await ctx.adapter('Client').find(abandoned.clientId)).toBeUndefined();
      expect(await ctx.adapter('Client').find(inFlight.clientId)).toBeDefined();

      vi.setSystemTime(T + 60 * DAY);
      const returning = await signedIn(ctx); // another client, authorized at day 60
      vi.setSystemTime(T + 91 * DAY);
      swept = await ctx.store.sweepExpired();
      expect(swept.deleted.oauthGrants).toBe(1); // unused's grant: its code expired unused and went first
      expect(swept.deleted.oauthUnusedClients).toBe(1);
      expect(await ctx.adapter('Client').find(unused.clientId)).toBeUndefined();
      expect(await ctx.adapter('Client').find(returning.clientId)).toBeDefined();
      // inFlight was registered at T and never signed in: abandoned once its interaction has gone.
      expect(swept.deleted.oauthAbandonedClients).toBe(1);
    },
  },

  // D4, D12: deletion and the account tools.
  {
    name: 'D4/D12: deleteUserData removes the user\'s library rows and grants and their 0.4.x rows in one step, and nobody else\'s',
    async run(ctx) {
      const u1 = await signedIn(ctx, 'u1');
      await saveToken(ctx, 'AccessToken', u1);
      await saveToken(ctx, 'RefreshToken', u1, 86_400);
      await ctx.adapter('AuthorizationCode').consume(u1.code);
      const session = libId();
      await ctx.adapter('Session').upsert(session, { kind: 'Session', jti: session, uid: libId(), accountId: 'u1', exp: nowSec() + 600 }, 600);
      const interaction = libId();
      await ctx.adapter('Interaction').upsert(interaction, { kind: 'Interaction', jti: interaction, params: { client_id: u1.clientId }, session: { accountId: 'u1' }, exp: nowSec() + 600 }, 600);
      const pending = await saveGrant(ctx, 'u1', u1.clientId);
      await stage(ctx, pending, 'u1');
      // A row under the user's grant that carries no account id goes with the grant.
      await ctx.store.upsertOAuthRow({
        key: `h1.${'f'.repeat(64)}`,
        model: 'Interaction',
        payload: '{}',
        grantId: u1.grantId,
        accountId: undefined,
        clientId: u1.clientId,
        uid: undefined,
        expiresAt: Date.now() + 600_000,
      });
      // 0.4.x rows of the same user.
      await ctx.store.saveAccessToken({ token: testKey('access', legacyToken()), clientId: u1.clientId, userId: 'u1', scopes: [], expiresAt: Date.now() + 3_600_000, familyId: 'f1' });
      await ctx.store.saveRefreshToken({ token: testKey('refresh', legacyToken()), clientId: u1.clientId, userId: 'u1', scopes: [], familyId: 'f1' });
      await ctx.store.saveAuthCode({ code: testKey('code', legacyToken()), clientId: u1.clientId, userId: 'u1', redirectUri: REDIRECT, codeChallenge: 'c', scopes: [], expiresAt: Date.now() + 600_000 });
      const u2 = await signedIn(ctx, 'u2');
      const u2Token = await saveToken(ctx, 'AccessToken', u2);
      const before = (await oauthRows(ctx.handle)).filter((r) => r.account_id === 'u2' || r.model === 'Client');

      await ctx.store.deleteUserData('u1');

      const after = await oauthRows(ctx.handle);
      expect(after.filter((r) => r.account_id === 'u1')).toEqual([]);
      expect(after.filter((r) => r.grant_id === u1.grantId || r.grant_id === pending)).toEqual([]);
      expect(Object.values(await ctx.handle.userRows('u1')).every((n) => n === 0)).toBe(true);
      expect(await ctx.store.getUser('u1')).toBeUndefined();
      expect(after.filter((r) => r.account_id === 'u2' || r.model === 'Client')).toEqual(before);
      expect(await ctx.adapter('AccessToken').find(u2Token)).toBeDefined();
    },
  },
  {
    name: 'D4: listConnections lists each grant with a live token; revokeUserFamily takes a grant id; deleteTokenFamiliesForClient revokes the client\'s grants',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const a = await signedIn(ctx, 'u1');
      await saveToken(ctx, 'RefreshToken', a, 30 * 86_400);
      vi.setSystemTime(T + 1000);
      const b = await saveGrant(ctx, 'u1', a.clientId, { scope: 'read-only read-write' });
      await saveToken(ctx, 'AccessToken', { accountId: 'u1', clientId: a.clientId, grantId: b }, 3600);
      vi.setSystemTime(T + 2000);
      const other = await registerClient(ctx, { client_name: 'Other' });
      const c = await saveGrant(ctx, 'u1', other.clientId, { scope: 'read-only read-write', rejected: 'read-write' });
      await saveToken(ctx, 'RefreshToken', { accountId: 'u1', clientId: other.clientId, grantId: c }, 86_400);
      await saveGrant(ctx, 'u1', other.clientId); // no token yet: not a connection
      const u2 = await signedIn(ctx, 'u2');
      await saveToken(ctx, 'RefreshToken', u2, 86_400);

      const list = await ctx.store.listConnections('u1');
      expect(list.map((x) => x.familyId)).toEqual([a.grantId, b, c]);
      expect(list[0]).toMatchObject({ clientId: a.clientId, clientName: 'Test Client', grantedScope: 'read-only', createdAt: T, lastUsedAt: T, expiresAt: T + 30 * DAY });
      expect(list[1]).toMatchObject({ grantedScope: 'read-write', createdAt: T + 1000, expiresAt: T + 1000 + 3_600_000 });
      expect(list[2]).toMatchObject({ clientName: 'Other', grantedScope: 'read-only' });

      expect(await ctx.store.revokeUserFamily('u2', a.grantId)).toBe(false);
      expect(await ctx.adapter('Grant').find(a.grantId)).toBeDefined();
      expect(await ctx.store.revokeUserFamily('u1', a.grantId)).toBe(true);
      expect((await oauthRows(ctx.handle)).filter((r) => r.grant_id === a.grantId)).toEqual([]);
      expect(await ctx.store.revokeUserFamily('u1', a.grantId)).toBe(false);

      expect(await ctx.store.deleteTokenFamiliesForClient('u1', a.clientId)).toBe(1);
      expect((await ctx.store.listConnections('u1')).map((x) => x.familyId)).toEqual([c]);
      expect((await ctx.store.listConnections('u2')).map((x) => x.familyId)).toEqual([u2.grantId]);
    },
  },

  // Through the library's own models.
  {
    name: 'the library\'s models round-trip through the adapter (spike 6, 15, 20, 21, 32, and D6\'s ignoreExpiration lookups)',
    async run(ctx) {
      vi.useFakeTimers({ toFake: ['Date'] });
      const T = Date.now();
      const provider = new Provider('https://as.example.com', {
        ...CLIENT_SCHEMA_CONFIGURATION,
        adapter: createOidcAdapter({ store: ctx.store, keys: TEST_TOKEN_HASHER }),
        jwks: ephemeralSigningKeys(),
        ttl: { AccessToken: 3600, AuthorizationCode: 600, RefreshToken: 86_400, Grant: 90 * 86_400, Session: 600, Interaction: 600 },
      });
      // DCR stores the client through the adapter; Client.find hands back the hash as the secret.
      const clientId = libId();
      const secret = randomBytes(64).toString('base64url');
      await provider.Client.adapter.upsert(clientId, { client_id: clientId, client_secret: secret, redirect_uris: [REDIRECT] });
      const client = await provider.Client.find(clientId);
      expect(client?.clientSecret).toBe(hashClientSecret(secret));

      const grant = new provider.Grant({ accountId: 'u1', clientId });
      grant.addResourceScope(R, 'read-only');
      const grantId = await grant.save();
      expect(await stage(ctx, grantId, 'u1')).toBe(true);
      const code = new provider.AuthorizationCode({
        accountId: 'u1',
        client,
        grantId,
        scope: 'read-only',
        codeChallenge: 'c'.repeat(43),
        codeChallengeMethod: 'S256',
        redirectUri: REDIRECT,
        resource: R,
      });
      const codeValue = await code.save();
      expect(codeValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const at = new provider.AccessToken({ accountId: 'u1', client, grantId, gty: 'authorization_code', scope: 'read-only' });
      at.resourceServer = new provider.ResourceServer(R, { scope: 'read-only read-write', audience: R, accessTokenFormat: 'opaque', accessTokenTTL: 3600 });
      const atValue = await at.save();
      const rt = new provider.RefreshToken({ accountId: 'u1', client, grantId, gty: 'authorization_code', scope: 'read-only', resource: R });
      const rtValue = await rt.save();

      const foundAt = await provider.AccessToken.find(atValue);
      expect(foundAt).toMatchObject({ accountId: 'u1', clientId, aud: R, jti: atValue, grantId });
      const dump = JSON.stringify(await oauthRows(ctx.handle));
      for (const value of [codeValue, atValue, rtValue, secret]) expect(dump).not.toContain(value);

      // Consume through the models; the second consume revokes the grant.
      const foundCode = await provider.AuthorizationCode.find(codeValue);
      await foundCode!.consume();
      const foundRt = await provider.RefreshToken.find(rtValue);
      await foundRt!.consume();
      // D6: past expiry the library refuses them, but an ignoreExpiration lookup still finds them, consumed.
      vi.setSystemTime(T + 2 * DAY);
      expect(await provider.RefreshToken.find(rtValue)).toBeUndefined();
      expect((await provider.RefreshToken.find(rtValue, { ignoreExpiration: true }))?.consumed).toBeTruthy();
      expect(await provider.AuthorizationCode.find(codeValue)).toBeUndefined();
      expect((await provider.AuthorizationCode.find(codeValue, { ignoreExpiration: true }))?.consumed).toBeTruthy();
      expect(await provider.AccessToken.find(atValue)).toBeUndefined();
      await expect(foundRt!.consume()).rejects.toBeInstanceOf(errors.InvalidGrant);
      expect(await provider.Grant.find(grantId, { ignoreExpiration: true })).toBeUndefined();
      expect(await provider.RefreshToken.find(rtValue, { ignoreExpiration: true })).toBeUndefined();
    },
  },
];

// ---- one suite per driver --------------------------------------------------

interface Target {
  name: string;
  driver: TestDriver;
  ready: boolean;
}

const targets: Target[] = testDrivers.map((driver) => ({ name: driver.name, driver, ready: ADAPTER_READY[driver.kind] }));

describe.each(targets)('OAuth adapter conformance: $name', ({ driver, ready }) => {
  if (!ready) {
    // PENDING (#47-1 driver step): this driver does not implement OAuthRowStore yet.
    for (const c of CASES) it.todo(`${c.name} [pending: #47-1 driver step]`);
    return;
  }
  describe.skipIf(!driver.enabled)(driver.name, () => {
    let ctx: Ctx;
    beforeEach(async () => {
      const handle = await driver.open();
      const store = handle.storage as Store;
      ctx = { handle, store, adapter: adapterOver(store) };
    });
    afterEach(async () => {
      vi.useRealTimers();
      await cleanupDrivers();
    });
    for (const c of CASES) it(c.name, () => c.run(ctx));
  });
});
