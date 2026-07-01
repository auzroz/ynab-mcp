/**
 * Unit tests for the federated OAuth core `McpOAuthProvider`.
 *
 * Uses a real MemoryStorage and a real Encryptor; only the YNAB network calls
 * (exchangeCode / getYnabUserId / refreshAccessToken) are mocked. buildAuthorizeUrl
 * is kept real so the produced YNAB authorize URL is genuinely exercised.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

vi.mock('../../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/auth/ynab-oauth.js')>(
      '../../../src/auth/ynab-oauth.js'
    );
  return {
    // Keep buildAuthorizeUrl real so we test the actual YNAB authorize URL.
    ...actual,
    exchangeCode: vi.fn(),
    getYnabUserId: vi.fn(),
    refreshAccessToken: vi.fn(),
  };
});

import { MemoryStorage } from '../../../src/storage/memory.js';
import { Encryptor } from '../../../src/crypto.js';
import { McpOAuthProvider, type McpProviderOptions } from '../../../src/auth/mcp-provider.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';

const exchangeCodeMock = vi.mocked(ynabOauth.exchangeCode);
const getYnabUserIdMock = vi.mocked(ynabOauth.getYnabUserId);
const refreshAccessTokenMock = vi.mocked(ynabOauth.refreshAccessToken);

/** A fake express Response capturing setHeader / send. */
interface FakeRes {
  setHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function makeRes(): FakeRes {
  return { setHeader: vi.fn(), send: vi.fn() };
}

function makeProvider(overrides: Partial<McpProviderOptions> = {}): {
  provider: McpOAuthProvider;
  storage: MemoryStorage;
  encryptor: Encryptor;
} {
  const storage = new MemoryStorage();
  const encryptor = new Encryptor(randomBytes(32).toString('base64'));
  const provider = new McpOAuthProvider({
    storage,
    encryptor,
    ynab: { clientId: 'cid', clientSecret: 'sec' },
    publicUrl: 'https://mcp.example.com',
    allowWrite: true,
    globalReadOnly: false,
    accessTokenTtlSec: 3600,
    authCodeTtlSec: 600,
    ...overrides,
  });
  return { provider, storage, encryptor };
}

const clientMetadata: OAuthClientMetadata = {
  redirect_uris: ['https://client/cb'],
  client_name: 'Test Client',
};

const authParams: AuthorizationParams = {
  redirectUri: 'https://client/cb',
  codeChallenge: 'chal',
  state: 'clientState',
  scopes: ['ynab'],
};

/** Extract the pending state from the read-only link in the consent HTML. */
function extractState(html: string): string {
  // The href is HTML-escaped, so `&` appears as `&amp;`.
  const m = /state=([^&"]+)&amp;scope=read-only/.exec(html);
  if (!m || m[1] === undefined) throw new Error('no read-only state link in HTML');
  return decodeURIComponent(m[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  exchangeCodeMock.mockResolvedValue({
    accessToken: 'ya',
    refreshToken: 'yr',
    expiresAt: Date.now() + 7200_000,
  });
  getYnabUserIdMock.mockResolvedValue('ynab-user-1');
  refreshAccessTokenMock.mockResolvedValue({
    accessToken: 'ya2',
    refreshToken: 'yr2',
    expiresAt: Date.now() + 7200_000,
  });
});

/** Register a client and drive the full flow up to (and returning) an MCP auth code. */
async function driveToAuthCode(
  provider: McpOAuthProvider,
  scope: 'read-only' | 'read-write' = 'read-write'
): Promise<{ client: OAuthClientInformationFull; code: string; redirectUrl: string }> {
  const client = await provider.clientsStore.registerClient(clientMetadata);
  const res = makeRes();
  await provider.authorize(client, authParams, res as unknown as Response);
  const html = res.send.mock.calls[0]?.[0] as string;
  const state = extractState(html);
  await provider.startYnabAuthorization(state, scope);
  const redirectUrl = await provider.handleYnabCallback('ynabcode', state);
  const code = new URL(redirectUrl).searchParams.get('code');
  if (code === null) throw new Error('no code in redirect');
  return { client, code, redirectUrl };
}

describe('McpOAuthProvider clientsStore', () => {
  it('registers a client with a generated id and round-trips getClient', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    expect(client.client_id).toBeTruthy();
    expect(typeof client.client_id).toBe('string');
    expect(client.redirect_uris).toEqual(['https://client/cb']);
    expect(client.client_id_issued_at).toBeTypeOf('number');

    const fetched = await provider.clientsStore.getClient(client.client_id);
    expect(fetched).toBeDefined();
    expect(fetched?.client_id).toBe(client.client_id);
  });

  it('getClient returns undefined for an unknown client', async () => {
    const { provider } = makeProvider();
    expect(await provider.clientsStore.getClient('nope')).toBeUndefined();
  });
});

describe('McpOAuthProvider.authorize', () => {
  it('renders the consent page with a read-only and (allowWrite) read-write link, and saves a pending auth', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();

    await provider.authorize(client, authParams, res as unknown as Response);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
    const html = res.send.mock.calls[0]?.[0] as string;
    expect(html).toContain('scope=read-only');
    expect(html).toContain('scope=read-write');
    expect(html).toContain('Read-only');

    // A pending auth now exists and is usable (observed via startYnabAuthorization).
    const state = extractState(html);
    // Proof the pending auth was persisted: it can be started (and after start,
    // startYnabAuthorization consumed+re-saved it, so a fresh unknown state fails).
    await expect(provider.startYnabAuthorization(state, 'read-only')).resolves.toBeTypeOf('string');
    await expect(provider.startYnabAuthorization('never-saved', 'read-only')).rejects.toThrow();
  });

  it('omits the read-write link when allowWrite is false', async () => {
    const { provider } = makeProvider({ allowWrite: false });
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const html = res.send.mock.calls[0]?.[0] as string;
    expect(html).toContain('scope=read-only');
    expect(html).not.toContain('scope=read-write');
  });
});

describe('McpOAuthProvider.startYnabAuthorization', () => {
  it('returns a real YNAB authorize URL for the chosen scope', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const state = extractState(res.send.mock.calls[0]?.[0] as string);

    const url = await provider.startYnabAuthorization(state, 'read-write');
    expect(typeof url).toBe('string');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://app.ynab.com/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('state')).toBe(state);
    // read-write => no scope restriction sent to YNAB.
    expect(parsed.searchParams.has('scope')).toBe(false);
  });

  it('forces read-only when globalReadOnly is true even if read-write is requested', async () => {
    const { provider } = makeProvider({ globalReadOnly: true });
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const state = extractState(res.send.mock.calls[0]?.[0] as string);

    const url = await provider.startYnabAuthorization(state, 'read-write');
    expect(new URL(url).searchParams.get('scope')).toBe('read-only');
  });

  it('forces read-only when allowWrite is false even if read-write is requested', async () => {
    const { provider } = makeProvider({ allowWrite: false });
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const state = extractState(res.send.mock.calls[0]?.[0] as string);

    const url = await provider.startYnabAuthorization(state, 'read-write');
    expect(new URL(url).searchParams.get('scope')).toBe('read-only');
  });

  it('throws on a bogus/expired state', async () => {
    const { provider } = makeProvider();
    await expect(provider.startYnabAuthorization('bogus', 'read-only')).rejects.toThrow();
  });
});

describe('McpOAuthProvider.handleYnabCallback', () => {
  it('redirects back to the client with code + client state and upserts an encrypted user', async () => {
    const { provider, storage, encryptor } = makeProvider();
    const { redirectUrl } = await driveToAuthCode(provider, 'read-write');

    expect(redirectUrl.startsWith('https://client/cb')).toBe(true);
    const parsed = new URL(redirectUrl);
    expect(parsed.searchParams.get('code')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBe('clientState');

    // A user was upserted with the chosen scope and an ENCRYPTED refresh token.
    const user = await storage.getUser('ynab-user-1');
    expect(user).toBeDefined();
    expect(user?.grantedScope).toBe('read-write');
    expect(user?.encryptedRefreshToken).not.toBe('yr');
    expect(encryptor.decrypt(user?.encryptedRefreshToken ?? '')).toBe('yr');

    // The YNAB calls were made with the callback URL / access token.
    expect(exchangeCodeMock).toHaveBeenCalledWith(
      { clientId: 'cid', clientSecret: 'sec' },
      { code: 'ynabcode', redirectUri: 'https://mcp.example.com/oauth/ynab/callback' }
    );
    expect(getYnabUserIdMock).toHaveBeenCalledWith('ya', undefined);
  });

  it('records the granted scope from the read-only consent choice', async () => {
    const { provider, storage } = makeProvider();
    await driveToAuthCode(provider, 'read-only');
    const user = await storage.getUser('ynab-user-1');
    expect(user?.grantedScope).toBe('read-only');
  });

  it('throws on a bogus/expired state', async () => {
    const { provider } = makeProvider();
    await expect(provider.handleYnabCallback('c', 'bogus')).rejects.toThrow();
  });
});

describe('McpOAuthProvider token issuance', () => {
  it('challenge + exchange issues bearer tokens and the code is single-use', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);

    const challenge = await provider.challengeForAuthorizationCode(client, code);
    expect(challenge).toBe('chal');

    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.expires_in).toBe(3600);

    // Reusing the same code fails.
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });

  it('challengeForAuthorizationCode throws for an unknown code', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await expect(provider.challengeForAuthorizationCode(client, 'nope')).rejects.toThrow();
  });

  it('exchangeAuthorizationCode rejects a client mismatch', async () => {
    const { provider } = makeProvider();
    const { code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(
      await provider.clientsStore.registerClient(clientMetadata),
      code
    );
    const other = await provider.clientsStore.registerClient(clientMetadata);
    await expect(provider.exchangeAuthorizationCode(other, code)).rejects.toThrow();
  });

  it('exchangeAuthorizationCode rejects a redirect_uri mismatch', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(client, code);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil/cb')
    ).rejects.toThrow();
  });
});

describe('McpOAuthProvider.verifyAccessToken', () => {
  it('returns AuthInfo with clientId and userId, and throws for unknown tokens', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
    expect(info.extra?.['userId']).toBe('ynab-user-1');
    expect(info.token).toBe(tokens.access_token);

    await expect(provider.verifyAccessToken('unknown-token')).rejects.toThrow();
  });
});

describe('McpOAuthProvider.exchangeRefreshToken', () => {
  it('issues new tokens and rotates (old refresh token cannot be reused)', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    const refresh = tokens.refresh_token;
    if (refresh === undefined) throw new Error('expected a refresh token');

    const rotated = await provider.exchangeRefreshToken(client, refresh);
    expect(rotated.access_token).toBeTruthy();
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(refresh);

    // The consumed refresh token is single-use.
    await expect(provider.exchangeRefreshToken(client, refresh)).rejects.toThrow();
  });

  it('rejects a refresh token belonging to another client', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    const refresh = tokens.refresh_token;
    if (refresh === undefined) throw new Error('expected a refresh token');

    const other = await provider.clientsStore.registerClient(clientMetadata);
    await expect(provider.exchangeRefreshToken(other, refresh)).rejects.toThrow();
  });
});

describe('McpOAuthProvider.revokeToken', () => {
  it('revokes an access token so verifyAccessToken then throws', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeDefined();
    await provider.revokeToken(client, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
});
