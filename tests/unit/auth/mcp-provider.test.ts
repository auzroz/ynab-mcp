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
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

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
  scope: 'read-only' | 'read-write' = 'read-write',
  params: Partial<AuthorizationParams> = {}
): Promise<{ client: OAuthClientInformationFull; code: string; redirectUrl: string }> {
  const client = await provider.clientsStore.registerClient(clientMetadata);
  const res = makeRes();
  await provider.authorize(client, { ...authParams, ...params }, res as unknown as Response);
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

describe('McpOAuthProvider issuer identification (RFC 9207)', () => {
  /** Run authorize() and return the pending state from the consent page. */
  async function pendingState(provider: McpOAuthProvider, params: Partial<AuthorizationParams> = {}): Promise<string> {
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, { ...authParams, ...params }, res as unknown as Response);
    return extractState(res.send.mock.calls[0]?.[0] as string);
  }

  it('defaults the issuer to the SDK metadata form of publicUrl', () => {
    expect(makeProvider().provider.issuer).toBe('https://mcp.example.com/');
    expect(makeProvider({ issuer: 'https://as.example.com/x' }).provider.issuer).toBe('https://as.example.com/x');
  });

  it('adds iss to the success redirect', async () => {
    const { provider } = makeProvider({ issuer: 'https://as.example.com/x' });
    const { redirectUrl } = await driveToAuthCode(provider);
    const parsed = new URL(redirectUrl);
    expect(parsed.searchParams.get('iss')).toBe('https://as.example.com/x');
    expect(parsed.searchParams.get('state')).toBe('clientState');
  });

  it('links a Cancel action on the consent page', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const html = res.send.mock.calls[0]?.[0] as string;
    const state = extractState(html);
    expect(html).toContain(`https://mcp.example.com/oauth/cancel?state=${encodeURIComponent(state)}`);
  });

  it('denyAuthorization redirects access_denied with state and iss, and consumes the pending auth', async () => {
    const { provider } = makeProvider();
    const state = await pendingState(provider);
    const url = new URL(await provider.denyAuthorization(state, 'access_denied'));
    expect(url.origin + url.pathname).toBe('https://client/cb');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toBe('The user denied the authorization request');
    expect(url.searchParams.get('state')).toBe('clientState');
    expect(url.searchParams.get('iss')).toBe('https://mcp.example.com/');
    expect(url.searchParams.has('code')).toBe(false);
    await expect(provider.denyAuthorization(state, 'access_denied')).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(provider.startYnabAuthorization(state, 'read-only')).rejects.toThrow();
  });

  it('denyAuthorization omits state when the client sent none, and supports server_error', async () => {
    const { provider } = makeProvider();
    const state = await pendingState(provider, { state: undefined });
    const url = new URL(await provider.denyAuthorization(state, 'server_error'));
    expect(url.searchParams.get('error')).toBe('server_error');
    expect(url.searchParams.has('state')).toBe(false);
    expect(url.searchParams.get('iss')).toBe('https://mcp.example.com/');
  });

  it('denyAuthorization throws for an unknown state', async () => {
    const { provider } = makeProvider();
    await expect(provider.denyAuthorization('bogus', 'access_denied')).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it.each([
    ['the YNAB code exchange', () => exchangeCodeMock.mockRejectedValueOnce(new Error('exchange failed'))],
    ['the YNAB user lookup', () => getYnabUserIdMock.mockRejectedValueOnce(new Error('user lookup failed'))],
  ])('a failure in %s redirects server_error with iss and saves no user', async (_label, arrange) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    const { provider, storage } = makeProvider();
    const state = await pendingState(provider);
    const url = new URL(await provider.handleYnabCallback('ynabcode', state));
    expect(url.searchParams.get('error')).toBe('server_error');
    expect(url.searchParams.get('error_description')).toBe('Could not complete YNAB authorization');
    expect(url.searchParams.get('state')).toBe('clientState');
    expect(url.searchParams.get('iss')).toBe('https://mcp.example.com/');
    expect(url.searchParams.has('code')).toBe(false);
    expect(await storage.getUser('ynab-user-1')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('ynabcode');
    errorSpy.mockRestore();
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

describe('McpOAuthProvider.revokeToken errors', () => {
  it('reports a generic server_error without storage details', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    vi.spyOn(storage, 'deleteAccessToken').mockRejectedValueOnce(
      new Error('connect ECONNREFUSED postgres://admin:hunter2@db:5432')
    );
    const err = await provider.revokeToken(client, { token: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as Error).message).toBe('Token revocation failed');
  });
});

// ---------------------------------------------------------------------------
// RFC 8707 resource binding + refresh scope narrowing
// ---------------------------------------------------------------------------

const RESOURCE = 'https://mcp.example.com/mcp';

/** Full flow to issued tokens; `resource` is sent at /authorize and/or /token as given. */
async function driveToTokens(
  provider: McpOAuthProvider,
  opts: { authorizeResource?: string; tokenResource?: string; scopes?: string[] } = {}
): Promise<{ client: OAuthClientInformationFull; tokens: OAuthTokens }> {
  const params: Partial<AuthorizationParams> = {};
  if (opts.authorizeResource !== undefined) params.resource = new URL(opts.authorizeResource);
  if (opts.scopes !== undefined) params.scopes = opts.scopes;
  const { client, code } = await driveToAuthCode(provider, 'read-write', params);
  await provider.challengeForAuthorizationCode(client, code);
  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    undefined,
    opts.tokenResource !== undefined ? new URL(opts.tokenResource) : undefined
  );
  return { client, tokens };
}

function refreshOf(tokens: OAuthTokens): string {
  if (tokens.refresh_token === undefined) throw new Error('expected a refresh token');
  return tokens.refresh_token;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e
  );
}

describe('McpOAuthProvider resource binding: /authorize', () => {
  it('rejects a foreign resource with invalid_target and saves nothing', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    const save = vi.spyOn(storage, 'savePendingAuth');

    const err = await errorOf(
      provider.authorize(
        client,
        { ...authParams, resource: new URL('https://evil.example.com/mcp') },
        res as unknown as Response
      )
    );
    expect(err).toBeInstanceOf(InvalidTargetError);
    expect((err as InvalidTargetError).errorCode).toBe('invalid_target');
    expect(res.send).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    'https://mcp.example.com/other',
    'https://mcp.example.com:8443/mcp',
    'http://mcp.example.com/mcp',
    'https://mcp.example.com/mcp?x=1',
  ])('rejects near-miss resource %s', async (resource) => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await expect(
      provider.authorize(
        client,
        { ...authParams, resource: new URL(resource) },
        makeRes() as unknown as Response
      )
    ).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it.each([RESOURCE, 'HTTPS://MCP.EXAMPLE.COM:443/mcp', `${RESOURCE}/`, `${RESOURCE}#frag`])(
    'accepts %s and binds the canonical resource through to the tokens',
    async (resource) => {
      const { provider, storage } = makeProvider();
      const saveCode = vi.spyOn(storage, 'saveAuthCode');
      const { tokens } = await driveToTokens(provider, { authorizeResource: resource });
      expect(saveCode.mock.calls[0]?.[0].resource).toBe(RESOURCE);
      expect((await storage.getAccessToken(tokens.access_token))?.resource).toBe(RESOURCE);
      const info = await provider.verifyAccessToken(tokens.access_token);
      expect(info.resource?.href).toBe(RESOURCE);
    }
  );

  it('allows a legacy client that sends no resource; tokens are still bound', async () => {
    const { provider, storage } = makeProvider();
    const saveCode = vi.spyOn(storage, 'saveAuthCode');
    const { tokens } = await driveToTokens(provider);
    expect(saveCode.mock.calls[0]?.[0].resource).toBeUndefined();
    expect((await storage.getAccessToken(tokens.access_token))?.resource).toBe(RESOURCE);
    expect((await provider.verifyAccessToken(tokens.access_token)).resource?.href).toBe(RESOURCE);
  });

  it('uses an explicit resourceUrl option instead of publicUrl + /mcp', async () => {
    const { provider } = makeProvider({ resourceUrl: 'https://mcp.example.com/api/mcp' });
    expect(provider.resource).toBe('https://mcp.example.com/api/mcp');
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await expect(
      provider.authorize(
        client,
        { ...authParams, resource: new URL(RESOURCE) },
        makeRes() as unknown as Response
      )
    ).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it('refuses to start with an unparseable resource URL', () => {
    expect(() => makeProvider({ resourceUrl: 'not a url' })).toThrow('Invalid MCP resource URL');
  });
});

describe('McpOAuthProvider resource binding: /token (authorization_code)', () => {
  it('accepts a matching resource at the token endpoint', async () => {
    const { provider } = makeProvider();
    const { tokens } = await driveToTokens(provider, {
      authorizeResource: RESOURCE,
      tokenResource: 'https://MCP.example.com/mcp/',
    });
    expect(tokens.access_token).toBeTruthy();
  });

  it('rejects a token request whose resource differs from the code', async () => {
    const { provider } = makeProvider();
    const err = await errorOf(
      driveToTokens(provider, {
        authorizeResource: RESOURCE,
        tokenResource: 'https://evil.example.com/mcp',
      })
    );
    expect(err).toBeInstanceOf(InvalidTargetError);
  });

  it('rejects a foreign resource at /token even when /authorize sent none', async () => {
    const { provider } = makeProvider();
    const err = await errorOf(
      driveToTokens(provider, { tokenResource: 'https://evil.example.com/mcp' })
    );
    expect(err).toBeInstanceOf(InvalidTargetError);
  });

  it('accepts a resource first named at /token when /authorize sent none', async () => {
    const { provider, storage } = makeProvider();
    const { tokens } = await driveToTokens(provider, { tokenResource: RESOURCE });
    expect((await storage.getAccessToken(tokens.access_token))?.resource).toBe(RESOURCE);
  });

  it('a mismatched resource burns the code (single use)', async () => {
    const { provider } = makeProvider();
    const { client, code } = await driveToAuthCode(provider);
    await provider.challengeForAuthorizationCode(client, code);
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        undefined,
        new URL('https://evil.example.com/mcp')
      )
    ).rejects.toBeInstanceOf(InvalidTargetError);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });

  it('exchanges a 0.3.x code (no stored resource) and binds the new tokens', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveAuthCode({
      code: 'legacy-code',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      redirectUri: 'https://client/cb',
      codeChallenge: 'chal',
      scopes: ['read-only'],
      expiresAt: Date.now() + 60_000,
    });
    await provider.challengeForAuthorizationCode(client, 'legacy-code');
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      'legacy-code',
      undefined,
      undefined,
      new URL(RESOURCE)
    );
    expect((await storage.getAccessToken(tokens.access_token))?.resource).toBe(RESOURCE);
  });

  it('rejects a code bound to a resource this server no longer serves', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveAuthCode({
      code: 'stale-code',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      redirectUri: 'https://client/cb',
      codeChallenge: 'chal',
      scopes: [],
      expiresAt: Date.now() + 60_000,
      resource: 'https://old.example.com/mcp',
    });
    await provider.challengeForAuthorizationCode(client, 'stale-code');
    await expect(provider.exchangeAuthorizationCode(client, 'stale-code')).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });
});

describe('McpOAuthProvider resource binding: /token (refresh_token)', () => {
  it('accepts a matching resource on refresh and keeps the binding', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { authorizeResource: RESOURCE });
    const rotated = await provider.exchangeRefreshToken(
      client,
      refreshOf(tokens),
      undefined,
      new URL(RESOURCE)
    );
    expect((await storage.getAccessToken(rotated.access_token))?.resource).toBe(RESOURCE);
    expect((await storage.takeRefreshToken(refreshOf(rotated)))?.resource).toBe(RESOURCE);
  });

  it('rejects a different resource on refresh and leaves the refresh token usable', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { authorizeResource: RESOURCE });
    const err = await errorOf(
      provider.exchangeRefreshToken(
        client,
        refreshOf(tokens),
        undefined,
        new URL('https://evil.example.com/mcp')
      )
    );
    expect(err).toBeInstanceOf(InvalidTargetError);
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).resolves.toHaveProperty(
      'access_token'
    );
  });

  it('refreshes a 0.3.x refresh token (no stored resource) and binds the new tokens', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveRefreshToken({
      token: 'legacy-rt',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      scopes: ['read-only', 'read-write'],
    });
    const rotated = await provider.exchangeRefreshToken(
      client,
      'legacy-rt',
      undefined,
      new URL(RESOURCE)
    );
    expect(rotated.scope).toBe('read-only read-write');
    expect((await storage.getAccessToken(rotated.access_token))?.resource).toBe(RESOURCE);
    expect((await storage.takeRefreshToken(refreshOf(rotated)))?.resource).toBe(RESOURCE);
  });

  it('rejects a refresh token bound to a resource this server no longer serves', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveRefreshToken({
      token: 'stale-rt',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      scopes: [],
      resource: 'https://old.example.com/mcp',
    });
    await expect(provider.exchangeRefreshToken(client, 'stale-rt')).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });
});

describe('McpOAuthProvider refresh scope (never widened)', () => {
  it('rejects a refresh that asks for a scope outside the original grant', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { scopes: ['read-only'] });
    const err = await errorOf(
      provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-only', 'read-write'])
    );
    expect(err).toBeInstanceOf(InvalidScopeError);
    expect((err as InvalidScopeError).errorCode).toBe('invalid_scope');
  });

  it('rejects any requested scope when the original grant had none', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { scopes: [] });
    await expect(
      provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-write'])
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it('keeps the original scope when none is requested (or only blanks)', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, {
      scopes: ['read-only', 'read-write'],
    });
    const a = await provider.exchangeRefreshToken(client, refreshOf(tokens));
    expect(a.scope).toBe('read-only read-write');
    const b = await provider.exchangeRefreshToken(client, refreshOf(a), ['', ' ']);
    expect(b.scope).toBe('read-only read-write');
  });

  it('narrows the access token on request; the rotated refresh token keeps the original grant', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, {
      scopes: ['read-only', 'read-write'],
    });
    const narrowed = await provider.exchangeRefreshToken(client, refreshOf(tokens), [
      'read-only',
      'read-only',
    ]);
    expect(narrowed.scope).toBe('read-only');
    expect((await provider.verifyAccessToken(narrowed.access_token)).scopes).toEqual(['read-only']);

    // RFC 6749 section 6: the new refresh token carries the original scope, so a
    // later refresh may return to it but still never beyond it.
    const restored = await provider.exchangeRefreshToken(client, refreshOf(narrowed), [
      'read-write',
    ]);
    expect(restored.scope).toBe('read-write');
    expect((await storage.takeRefreshToken(refreshOf(restored)))?.scopes).toEqual([
      'read-only',
      'read-write',
    ]);
  });
});

describe('McpOAuthProvider.verifyAccessToken resource checks', () => {
  it('accepts a 0.3.x access token (no stored resource) and reports this resource', async () => {
    const { provider, storage } = makeProvider();
    await storage.saveAccessToken({
      token: 'legacy-at',
      clientId: 'c1',
      userId: 'ynab-user-1',
      scopes: [],
      expiresAt: Date.now() + 60_000,
    });
    const info = await provider.verifyAccessToken('legacy-at');
    expect(info.resource?.href).toBe(RESOURCE);
    expect(info.extra?.['userId']).toBe('ynab-user-1');
  });

  it('rejects an access token bound to another resource', async () => {
    const { provider, storage } = makeProvider();
    await storage.saveAccessToken({
      token: 'foreign-at',
      clientId: 'c1',
      userId: 'ynab-user-1',
      scopes: [],
      expiresAt: Date.now() + 60_000,
      resource: 'https://mcp.example.com/other',
    });
    const err = await errorOf(provider.verifyAccessToken('foreign-at'));
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect((err as Error).message).toBe('Invalid or expired access token');
  });
});
