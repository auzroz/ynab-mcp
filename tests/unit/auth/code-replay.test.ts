/**
 * Authorization-code replay in McpOAuthProvider (RFC 9700 section 4.2.4,
 * issue #42), on every storage driver: memory always, SQLite when
 * better-sqlite3 loads, Postgres when DATABASE_URL is set (REQUIRE_DB_TESTS=1
 * makes a missing driver fail instead of skip).
 *
 * The races (a replay landing between the code being spent and its tokens
 * being saved) use barrier mocks around the storage calls, never sleeps.
 * Only the YNAB network calls are mocked.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Response } from 'express';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>(
      '../../../src/auth/ynab-oauth.js'
    );
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

import type { Storage, CodeTokens } from '../../../src/storage/types.js';
import { MemoryStorage } from '../../../src/storage/memory.js';
import { Encryptor } from '../../../src/crypto.js';
import {
  McpOAuthProvider,
  AUTH_CODE_REPLAY_WINDOW_MS,
  CODE_EXCHANGE_WINDOW_MS,
} from '../../../src/auth/mcp-provider.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';

const INVALID_CODE = { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' };

/** A promise and the function that resolves it: one side waits, the other opens it. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

function refreshOf(tokens: OAuthTokens): string {
  if (tokens.refresh_token === undefined) throw new Error('no refresh token');
  return tokens.refresh_token;
}

const sqliteAvailable = ((): boolean => {
  try {
    createRequire(import.meta.url)('better-sqlite3');
    return true;
  } catch {
    return false;
  }
})();
const requireDbTests = process.env.REQUIRE_DB_TESTS === '1';
const sqliteFiles: string[] = [];

const drivers: Array<{ name: string; enabled: boolean; open: () => Promise<Storage> }> = [
  {
    name: 'MemoryStorage',
    enabled: true,
    open: async () => {
      const s = new MemoryStorage();
      await s.init();
      return s;
    },
  },
  {
    name: 'SqliteStorage',
    enabled: sqliteAvailable || requireDbTests,
    open: async () => {
      const { SqliteStorage } = await import('../../../src/storage/sqlite.js');
      const file = join(tmpdir(), `ynab-mcp-code-replay-${randomUUID()}.db`);
      sqliteFiles.push(file);
      const s = new SqliteStorage({ path: file });
      await s.init();
      return s;
    },
  },
  {
    name: 'PostgresStorage',
    enabled: Boolean(process.env.DATABASE_URL) || requireDbTests,
    open: async () => {
      const { PostgresStorage } = await import('../../../src/storage/postgres.js');
      const s = new PostgresStorage({ connectionString: await postgresSchemaUrl() });
      await s.init();
      return s;
    },
  },
];

/**
 * This file's own Postgres schema, created on first use and dropped at the end.
 * Every test opens (and so migrates) a fresh PostgresStorage; in a schema of its
 * own that migration never contends for the tables storage.test.ts uses in
 * parallel (an init() racing a refresh-token rotation on the same tables can
 * deadlock; see the PR notes).
 */
let pgSchema: { name: string; url: string } | undefined;
async function postgresSchemaUrl(): Promise<string> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL not set (REQUIRE_DB_TESTS=1)');
  if (!pgSchema) {
    const pg = (await import('pg')).default;
    const name = `code_replay_${randomUUID().replace(/-/g, '')}`;
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE SCHEMA ${name}`);
    } finally {
      await admin.end();
    }
    const url = new URL(base);
    url.searchParams.set('options', `-c search_path=${name}`);
    pgSchema = { name, url: url.toString() };
  }
  return pgSchema.url;
}

afterAll(async () => {
  if (!pgSchema) return;
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${pgSchema.name} CASCADE`);
  } finally {
    await admin.end();
  }
});

afterEach(() => {
  for (const f of sqliteFiles.splice(0)) {
    rmSync(f, { force: true });
    rmSync(`${f}-wal`, { force: true });
    rmSync(`${f}-shm`, { force: true });
  }
});

for (const driver of drivers) {
  describe.skipIf(!driver.enabled)(`authorization-code replay: ${driver.name}`, () => {
    let storage: Storage;
    let provider: McpOAuthProvider;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(ynabOauth.exchangeCode).mockResolvedValue({
        accessToken: 'ya',
        refreshToken: 'yr',
        expiresAt: Date.now() + 7200_000,
      });
      vi.mocked(ynabOauth.getYnabUserId).mockResolvedValue(`ynab-user-${randomUUID()}`);
      storage = await driver.open();
      provider = new McpOAuthProvider({
        storage,
        encryptor: new Encryptor(randomBytes(32).toString('base64')),
        ynab: { clientId: 'cid', clientSecret: 'sec' },
        publicUrl: 'https://mcp.example.com',
        allowWrite: true,
        globalReadOnly: false,
        accessTokenTtlSec: 3600,
        authCodeTtlSec: 600,
      });
    });

    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await storage.close();
    });

    async function newClient(): Promise<OAuthClientInformationFull> {
      return provider.clientsStore.registerClient({ redirect_uris: ['https://client/cb'], client_name: 'c' });
    }

    /** Consent, start and callback: an MCP code for `client`. */
    async function codeFor(client: OAuthClientInformationFull): Promise<string> {
      const res = { setHeader: vi.fn(), append: vi.fn(), send: vi.fn() };
      await provider.authorize(
        client,
        { redirectUri: 'https://client/cb', codeChallenge: 'chal', state: 's', scopes: ['ynab'] },
        res as unknown as Response
      );
      const html = res.send.mock.calls[0]?.[0] as string;
      const state = decodeURIComponent(/state=([^&"]+)&amp;scope=read-only/.exec(html)?.[1] ?? '');
      const cookie = (res.append.mock.calls.find((c) => c[0] === 'Set-Cookie')?.[1] as string).split(';')[0] ?? '';
      const nonce = cookie.slice(cookie.indexOf('=') + 1);
      await provider.startYnabAuthorization(state, 'read-write', nonce);
      const code = new URL(await provider.handleYnabCallback('ynabcode', state, nonce)).searchParams.get('code');
      if (code === null) throw new Error('no code');
      return code;
    }

    /** What the SDK's token handler does: challenge (the PKCE check), then exchange. */
    async function redeem(client: OAuthClientInformationFull, code: string): Promise<OAuthTokens> {
      await provider.challengeForAuthorizationCode(client, code);
      return provider.exchangeAuthorizationCode(client, code);
    }

    async function expectDead(client: OAuthClientInformationFull, tokens: OAuthTokens): Promise<void> {
      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
      await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
        InvalidGrantError
      );
    }

    async function expectLive(client: OAuthClientInformationFull, tokens: OAuthTokens): Promise<void> {
      await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
        clientId: client.client_id,
      });
      await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).resolves.toHaveProperty(
        'access_token'
      );
    }

    it('replaying a code revokes the access and refresh tokens it produced, and their refreshes', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      const tokens = await redeem(client, code);
      const rotated = await provider.exchangeRefreshToken(client, refreshOf(tokens));

      const err = await errorOf(provider.challengeForAuthorizationCode(client, code));
      expect((err as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);

      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
      await expectDead(client, rotated);
      expect(errorSpy).toHaveBeenCalledWith('[OAuth] Authorization code replay detected; revoked its token family');
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(code);
    });

    it('a replay from another client also revokes the family', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      const tokens = await redeem(client, code);
      await expect(provider.challengeForAuthorizationCode(await newClient(), code)).rejects.toBeInstanceOf(
        InvalidGrantError
      );
      await expectDead(client, tokens);
    });

    it("leaves the user's other families alone, for the same client and for another client", async () => {
      const client = await newClient();
      const code = await codeFor(client);
      await redeem(client, code);
      const sameClient = await redeem(client, await codeFor(client));
      const otherClient = await newClient();
      const other = await redeem(otherClient, await codeFor(otherClient));

      await expect(provider.challengeForAuthorizationCode(client, code)).rejects.toBeInstanceOf(InvalidGrantError);

      await expectLive(client, sameClient);
      await expectLive(otherClient, other);
    });

    it('answers unknown, replayed and re-replayed codes identically', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      await redeem(client, code);

      const unknown = await errorOf(provider.challengeForAuthorizationCode(client, 'never-issued'));
      const replayed = await errorOf(provider.challengeForAuthorizationCode(client, code));
      const again = await errorOf(provider.challengeForAuthorizationCode(client, code));
      for (const err of [unknown, replayed, again]) {
        expect(err).toBeInstanceOf(InvalidGrantError);
        expect((err as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      }
    });

    it('a replay between challenge and exchange leaves no live token (exchange refused)', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      await provider.challengeForAuthorizationCode(client, code);
      // The replay lands after the code is spent, before the exchange.
      await expect(provider.challengeForAuthorizationCode(client, code)).rejects.toBeInstanceOf(InvalidGrantError);

      const save = vi.spyOn(storage, 'saveCodeTokens');
      const err = await errorOf(provider.exchangeAuthorizationCode(client, code));
      expect((err as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      const attempted = save.mock.calls[0]?.[1] as CodeTokens;
      expect(await storage.getAccessToken(attempted.accessToken.token)).toBeUndefined();
      expect(await storage.getRefreshToken(attempted.refreshToken.token)).toBeUndefined();
    });

    it('a replay that revokes while the exchange is about to save: the save is refused', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      await provider.challengeForAuthorizationCode(client, code);

      // Hold the exchange at its save until the replay has revoked the code.
      const reached = barrier();
      const release = barrier();
      const realSave = storage.saveCodeTokens.bind(storage);
      let attempted: CodeTokens | undefined;
      vi.spyOn(storage, 'saveCodeTokens').mockImplementation(async (c, tokens) => {
        attempted = tokens;
        reached.open();
        await release.wait;
        return realSave(c, tokens);
      });

      const exchange = errorOf(provider.exchangeAuthorizationCode(client, code));
      await reached.wait;
      await expect(provider.challengeForAuthorizationCode(client, code)).rejects.toBeInstanceOf(InvalidGrantError);
      release.open();

      expect(((await exchange) as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      if (!attempted) throw new Error('save not attempted');
      expect(await storage.getAccessToken(attempted.accessToken.token)).toBeUndefined();
      expect(await storage.getRefreshToken(attempted.refreshToken.token)).toBeUndefined();
    });

    it('a replay that revokes right after the exchange saved: the issued pair is dead', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      await provider.challengeForAuthorizationCode(client, code);

      // The replay has found the code spent and is about to revoke; the exchange
      // completes first.
      const reached = barrier();
      const release = barrier();
      const realRevoke = storage.revokeConsumedAuthCode.bind(storage);
      vi.spyOn(storage, 'revokeConsumedAuthCode').mockImplementation(async (c) => {
        reached.open();
        await release.wait;
        return realRevoke(c);
      });

      const replay = errorOf(provider.challengeForAuthorizationCode(client, code));
      await reached.wait;
      const tokens = await provider.exchangeAuthorizationCode(client, code);
      release.open();

      expect(((await replay) as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      await expectDead(client, tokens);
    });

    it('two concurrent token requests with one code: at most one gets tokens, and none survive', async () => {
      const client = await newClient();
      const code = await codeFor(client);
      const results = await Promise.allSettled([redeem(client, code), redeem(client, code)]);
      const issued = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      expect(issued.length).toBeLessThanOrEqual(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect((r.reason as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
        }
      }
      for (const tokens of issued) await expectDead(client, tokens);
    });

    it('a code from before the tombstones (no access level or resource) still redeems', async () => {
      const client = await newClient();
      await storage.saveAuthCode({
        code: 'legacy-code',
        clientId: client.client_id,
        userId: 'legacy-user',
        redirectUri: 'https://client/cb',
        codeChallenge: 'chal',
        scopes: ['ynab'],
        expiresAt: Date.now() + 60_000,
      });
      const tokens = await redeem(client, 'legacy-code');
      await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
        extra: { userId: 'legacy-user', grantedScope: 'read-only' },
      });
      // And its replay is detected like any other.
      await expect(provider.challengeForAuthorizationCode(client, 'legacy-code')).rejects.toBeInstanceOf(
        InvalidGrantError
      );
      await expectDead(client, tokens);
    });

    it(`keeps a code tombstone for ${AUTH_CODE_REPLAY_WINDOW_MS / 60_000} minutes, then a replay just fails`, async () => {
      expect(AUTH_CODE_REPLAY_WINDOW_MS).toBe(10 * 60_000);
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = await newClient();
      const code = await codeFor(client);
      const spentAt = Date.now();
      const tokens = await redeem(client, code);
      expect(await storage.getConsumedAuthCode(code)).toMatchObject({
        clientId: client.client_id,
        expiresAt: spentAt + AUTH_CODE_REPLAY_WINDOW_MS,
        revoked: false,
      });

      vi.setSystemTime(spentAt + AUTH_CODE_REPLAY_WINDOW_MS + 1);
      const del = vi.spyOn(storage, 'deleteTokenFamily');
      const err = await errorOf(provider.challengeForAuthorizationCode(client, code));
      expect((err as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      expect(del).not.toHaveBeenCalled();
      await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
        clientId: client.client_id,
      });
    });

    it(`a spent code is exchangeable for ${CODE_EXCHANGE_WINDOW_MS / 1000} s; stale entries are pruned`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = await newClient();
      const stale = await codeFor(client);
      // A request that failed between challenge and exchange (e.g. the PKCE check).
      await provider.challengeForAuthorizationCode(client, stale);
      const pending = Reflect.get(provider, 'consumedCodes') as Map<string, unknown>;
      expect(pending.has(stale)).toBe(true);

      vi.setSystemTime(Date.now() + CODE_EXCHANGE_WINDOW_MS + 1);
      const fresh = await codeFor(client);
      await provider.challengeForAuthorizationCode(client, fresh);
      expect(pending.has(stale)).toBe(false);
      expect(pending.has(fresh)).toBe(true);
      const err = await errorOf(provider.exchangeAuthorizationCode(client, stale));
      expect((err as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      await expect(provider.exchangeAuthorizationCode(client, fresh)).resolves.toHaveProperty('access_token');
    });

    it('an entry past the window is refused at exchange even before it is pruned', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = await newClient();
      const code = await codeFor(client);
      await provider.challengeForAuthorizationCode(client, code);
      vi.setSystemTime(Date.now() + CODE_EXCHANGE_WINDOW_MS + 1);
      const save = vi.spyOn(storage, 'saveCodeTokens');
      const err = await errorOf(provider.exchangeAuthorizationCode(client, code));
      expect((err as InvalidGrantError).toResponseObject()).toEqual(INVALID_CODE);
      expect(save).not.toHaveBeenCalled();
    });
  });
}
