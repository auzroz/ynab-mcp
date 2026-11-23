/**
 * The write cap across separate requests in stateless HTTP mode (#61c, WS7.4).
 * /mcp builds a new server per request, so the cap must live in the user's
 * registry components, not in the request. 21 writes as 21 separate HTTP
 * requests: the 21st is refused and never reaches YNAB. Mock YNAB only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { plantAccessToken } from './helpers/oauth-state.js';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    refreshAccessToken: vi.fn(async () => ({
      accessToken: 'ynab-access',
      refreshToken: 'ynab-refresh-2',
      expiresAt: Date.now() + 7200_000,
    })),
  };
});

const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import { buildHttpApp, createHttpApp, type HttpApp } from '../../src/http.js';
import { Encryptor } from '../../src/crypto.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { bearer, mcpConnect, ynabToken, type McpAuth } from './helpers/mcp-call.js';

const BUDGET = '11111111-1111-4111-8111-111111111111';
const WRITE_ARGS = { budget_id: BUDGET, name: 'Corner Shop' };

let handle: HttpApp | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

function stubYnab(): void {
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ data: { payee: { id: '33333333-3333-4333-8333-333333333333', name: 'Corner Shop' } } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

afterEach(async () => {
  await handle?.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  handle = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 21 writes, each its own HTTP request; returns each reply's error type (undefined on success). */
async function twentyOneWrites(connect: () => ReturnType<typeof mcpConnect>, auths?: McpAuth[]) {
  const mcp = await connect();
  const types: Array<string | undefined> = [];
  for (let i = 0; i < 21; i++) {
    const r = await mcp.callTool('ynab_create_payee', WRITE_ARGS, auths ? { auth: auths[i % auths.length]! } : undefined);
    types.push(r.isError ? (JSON.parse(r.text) as { type?: string }).type : undefined);
  }
  return types;
}

describe('write cap across stateless HTTP requests', () => {
  it('header mode: the 21st write from one token is refused and never reaches YNAB', async () => {
    stubYnab();
    const app = await createHttpApp(makeHttpConfig({ readOnly: false }));
    const types = await twentyOneWrites(() => mcpConnect(app, ynabToken('token-a')));
    expect(types.slice(0, 20).every((t) => t !== 'write_limit_exceeded')).toBe(true);
    expect(types[20]).toBe('write_limit_exceeded');
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });

  it('header mode: another token has its own cap', async () => {
    stubYnab();
    const app = await createHttpApp(makeHttpConfig({ readOnly: false, writeLimitPerHour: 2 }));
    const a = await mcpConnect(app, ynabToken('token-a'));
    const b = await mcpConnect(app, ynabToken('token-b'));
    await a.callTool('ynab_create_payee', WRITE_ARGS);
    await a.callTool('ynab_create_payee', WRITE_ARGS);
    expect(JSON.parse((await a.callTool('ynab_create_payee', WRITE_ARGS)).text)).toMatchObject({
      type: 'write_limit_exceeded',
    });
    expect((await b.callTool('ynab_create_payee', WRITE_ARGS)).isError).toBe(false);
  });

  it('oauth mode: the 21st write from one user, across two clients, is refused', async () => {
    stubYnab();
    const PUBLIC_URL = 'https://mcp.example.com';
    const RESOURCE = `${PUBLIC_URL}/mcp`;
    const encryptionKey = randomBytes(32).toString('base64');
    handle = await buildHttpApp(
      makeHttpConfig({
        publicUrl: PUBLIC_URL,
        resourceUrl: RESOURCE,
        authMode: 'oauth',
        oauthClientId: 'cid',
        oauthClientSecret: 'sec',
        encryptionKey,
        tokenPepper: TEST_TOKEN_PEPPER,
        readOnly: false,
        allowWrite: true,
      })
    );
    const storage = created.storage!;
    await storage.upsertUser({
      userId: 'ynab-user-1',
      grantedScope: 'read-write',
      encryptedRefreshToken: new Encryptor(encryptionKey).encrypt('ynab-refresh-1'),
      updatedAt: Date.now(),
    });
    const tokens: string[] = [];
    for (const clientId of ['client-a', 'client-b']) {
      tokens.push(
        await plantAccessToken(storage, {
          clientId,
          userId: 'ynab-user-1',
          scopes: ['read-write'],
          expiresAt: Date.now() + 3_600_000,
          resource: RESOURCE,
          grantedScope: 'read-write',
        })
      );
    }
    const auths = tokens.map((t) => bearer(t));
    const types = await twentyOneWrites(() => mcpConnect(handle!.app, auths[0]!), auths);
    expect(types.slice(0, 20).every((t) => t === undefined)).toBe(true);
    expect(types[20]).toBe('write_limit_exceeded');
    // YNAB was reached by exactly the 20 admitted writes (token refresh is mocked).
    expect(fetchSpy).toHaveBeenCalledTimes(20);
  });
});
