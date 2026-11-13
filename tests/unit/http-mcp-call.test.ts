/**
 * The MCP-over-HTTP test helper (tests/unit/helpers/mcp-call.ts), against the
 * real app in header mode and in oauth mode (bearer tokens through the SDK's
 * bearer check). Nothing here calls YNAB: in oauth mode only YNAB's token
 * refresh is reached, and it is mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
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

// Keeps a handle on the storage the app creates, to plant the tokens the
// authorization server would have issued.
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
import { anonymous, bearer, mcpConnect, mcpInitialize, rpcMessage, ynabToken } from './helpers/mcp-call.js';

describe('mcp-call helper', () => {
  it('connects, sends requests and closes without the caller handling a session id', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const mcp = await mcpConnect(app, ynabToken('token-a'));
    expect(mcp.initializeResult['serverInfo']).toBeDefined();

    const ping = await mcp.request('ping');
    expect(ping.status).toBe(200);
    expect(ping.message?.['result']).toEqual({});

    expect(await mcp.listTools()).toContain('ynab_list_budgets');

    const closed = await mcp.close();
    expect(closed?.status).toBe(200);
    expect(await mcp.close()).toBeUndefined();
  });

  it('assigns a new id to each request', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const mcp = await mcpConnect(app, ynabToken('token-a'));
    const first = await mcp.request('ping');
    const second = await mcp.request('ping');
    expect(first.message?.['id']).not.toBe(second.message?.['id']);
  });

  it('sends a single request with other credentials when asked', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const mcp = await mcpConnect(app, ynabToken('token-a'));
    // The connection belongs to token-a; another token is refused.
    expect((await mcp.request('ping', {}, { auth: ynabToken('token-b') })).status).toBe(404);
  });

  it('exposes a refused initialize and throws from connect', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const res = await mcpInitialize(app, anonymous);
    expect(res.status).toBe(401);
    expect(rpcMessage(res)['error']['code']).toBe(-32001);
    await expect(mcpConnect(app, anonymous)).rejects.toThrow('initialize refused: 401');
  });
});

describe('mcp-call helper in oauth mode', () => {
  const PUBLIC_URL = 'https://mcp.example.com';
  const RESOURCE = `${PUBLIC_URL}/mcp`;
  const USER = 'ynab-user-1';
  let handle: HttpApp | undefined;

  afterEach(async () => {
    await handle?.sessions.close();
    await created.storage?.close();
    created.storage = undefined;
    handle = undefined;
    vi.restoreAllMocks();
  });

  /** The app, with a YNAB user and an MCP access token per client, as the AS stores them. */
  async function oauthApp(clients: readonly string[]): Promise<{ app: HttpApp['app']; tokens: string[] }> {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const encryptionKey = randomBytes(32).toString('base64');
    handle = await buildHttpApp(
      makeHttpConfig({
        publicUrl: PUBLIC_URL,
        resourceUrl: RESOURCE,
        authMode: 'oauth',
        oauthClientId: 'cid',
        oauthClientSecret: 'sec',
        encryptionKey,
        // The shared test pepper, so the tokens below can be planted under their h1. keys.
        tokenPepper: TEST_TOKEN_PEPPER,
        // Writes on server-wide, so only the grant can hide the write tools.
        readOnly: false,
      })
    );
    const storage = created.storage!;
    await storage.upsertUser({
      userId: USER,
      grantedScope: 'read-only',
      encryptedRefreshToken: new Encryptor(encryptionKey).encrypt('ynab-refresh-1'),
      updatedAt: Date.now(),
    });
    const tokens: string[] = [];
    for (const clientId of clients) {
      const { value: token, key } = TEST_TOKEN_HASHER.issue('access');
      await storage.saveAccessToken({
        token: key,
        clientId,
        userId: USER,
        scopes: ['read-only'],
        expiresAt: Date.now() + 3_600_000,
        resource: RESOURCE,
        grantedScope: 'read-only',
      });
      tokens.push(token);
    }
    return { app: handle.app, tokens };
  }

  it('connects with a bearer token, sends requests and closes', async () => {
    const { app, tokens } = await oauthApp(['client-a']);
    const mcp = await mcpConnect(app, bearer(tokens[0]!));
    expect(mcp.initializeResult['serverInfo']).toBeDefined();
    expect((await mcp.request('ping')).message?.['result']).toEqual({});
    // A read-only grant: read tools only.
    const names = await mcp.listTools();
    expect(names).toContain('ynab_list_budgets');
    expect(names).not.toContain('ynab_create_transaction');
    expect((await mcp.close())?.status).toBe(200);
  });

  it("refuses another client's token on the connection", async () => {
    const { app, tokens } = await oauthApp(['client-a', 'client-b']);
    const mcp = await mcpConnect(app, bearer(tokens[0]!));
    expect((await mcp.request('ping', {}, { auth: bearer(tokens[1]!) })).status).toBe(404);
    expect((await mcp.request('ping')).status).toBe(200);
    // A refused close keeps the session, so the owner can still close it.
    expect((await mcp.close({ auth: bearer(tokens[1]!) }))?.status).toBe(404);
    expect((await mcp.close())?.status).toBe(200);
  });

  it("reports the bearer check's refusal with its challenge", async () => {
    const { app } = await oauthApp([]);
    const res = await mcpInitialize(app, bearer('not-a-token'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    // The refused token is echoed nowhere: not in the body, the challenge or the helper's error.
    expect(res.text).not.toContain('not-a-token');
    expect(res.headers['www-authenticate']).not.toContain('not-a-token');
    const err = await mcpConnect(app, bearer('not-a-token')).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /^initialize refused: 401 .*invalid_token.*\(WWW-Authenticate: Bearer .*resource_metadata=/
    );
    expect((err as Error).message).not.toContain('not-a-token');
    await expect(mcpConnect(app, anonymous)).rejects.toThrow(/^initialize refused: 401 .*WWW-Authenticate: Bearer/);
  });
});
