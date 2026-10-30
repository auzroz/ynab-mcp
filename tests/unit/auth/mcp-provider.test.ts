/**
 * Unit tests for the federated OAuth core `McpOAuthProvider`.
 *
 * Uses a real MemoryStorage and a real Encryptor; only the YNAB network calls
 * (exchangeCode / getYnabUserId / refreshAccessToken) are mocked. buildAuthorizeUrl
 * is kept real so the produced YNAB authorize URL is genuinely exercised.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
import {
  McpOAuthProvider,
  REFRESH_TOKEN_REUSE_WINDOW_MS,
  type McpProviderOptions,
} from '../../../src/auth/mcp-provider.js';
import * as ynabOauth from '../../../src/auth/ynab-oauth.js';

const exchangeCodeMock = vi.mocked(ynabOauth.exchangeCode);
const getYnabUserIdMock = vi.mocked(ynabOauth.getYnabUserId);
const refreshAccessTokenMock = vi.mocked(ynabOauth.refreshAccessToken);

/** A fake express Response capturing setHeader / append / send. */
interface FakeRes {
  setHeader: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function makeRes(): FakeRes {
  return { setHeader: vi.fn(), append: vi.fn(), send: vi.fn() };
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

/** The Set-Cookie value authorize() appended (the consent cookie). */
function setCookieOf(res: FakeRes): string {
  const call = res.append.mock.calls.find((c) => c[0] === 'Set-Cookie');
  if (!call) throw new Error('no Set-Cookie');
  return call[1] as string;
}

/** Pending state, consent-cookie nonce and HTML from an authorize() response. */
function consentOf(res: FakeRes): { state: string; nonce: string; html: string } {
  const html = res.send.mock.calls[0]?.[0] as string;
  const pair = setCookieOf(res).split(';')[0] ?? '';
  const nonce = pair.slice(pair.indexOf('=') + 1);
  return { state: extractState(html), nonce, html };
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
  const { state, nonce } = consentOf(res);
  await provider.startYnabAuthorization(state, scope, nonce);
  const redirectUrl = await provider.handleYnabCallback('ynabcode', state, nonce);
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
    const { state, nonce } = consentOf(res);
    // Proof the pending auth was persisted: it can be started (and after start,
    // startYnabAuthorization consumed+re-saved it, so a fresh unknown state fails).
    await expect(provider.startYnabAuthorization(state, 'read-only', nonce)).resolves.toBeTypeOf('string');
    await expect(provider.startYnabAuthorization('never-saved', 'read-only', nonce)).rejects.toThrow();
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
    const { state, nonce } = consentOf(res);

    const url = await provider.startYnabAuthorization(state, 'read-write', nonce);
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
    const { state, nonce } = consentOf(res);

    const url = await provider.startYnabAuthorization(state, 'read-write', nonce);
    expect(new URL(url).searchParams.get('scope')).toBe('read-only');
  });

  it('forces read-only when allowWrite is false even if read-write is requested', async () => {
    const { provider } = makeProvider({ allowWrite: false });
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const { state, nonce } = consentOf(res);

    const url = await provider.startYnabAuthorization(state, 'read-write', nonce);
    expect(new URL(url).searchParams.get('scope')).toBe('read-only');
  });

  it('throws on a bogus/expired state', async () => {
    const { provider } = makeProvider();
    await expect(provider.startYnabAuthorization('bogus', 'read-only', 'nonce')).rejects.toThrow();
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
    await expect(provider.handleYnabCallback('c', 'bogus', 'nonce')).rejects.toThrow();
  });
});

describe('McpOAuthProvider issuer identification (RFC 9207)', () => {
  /** Run authorize() and return the pending state and consent nonce. */
  async function pendingState(
    provider: McpOAuthProvider,
    params: Partial<AuthorizationParams> = {}
  ): Promise<{ state: string; nonce: string }> {
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, { ...authParams, ...params }, res as unknown as Response);
    return consentOf(res);
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
    const { state, nonce } = await pendingState(provider);
    const url = new URL(await provider.denyAuthorization(state, 'access_denied', nonce));
    expect(url.origin + url.pathname).toBe('https://client/cb');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('error_description')).toBe('The user denied the authorization request');
    expect(url.searchParams.get('state')).toBe('clientState');
    expect(url.searchParams.get('iss')).toBe('https://mcp.example.com/');
    expect(url.searchParams.has('code')).toBe(false);
    await expect(provider.denyAuthorization(state, 'access_denied', nonce)).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(provider.startYnabAuthorization(state, 'read-only', nonce)).rejects.toThrow();
  });

  it('denyAuthorization omits state when the client sent none, and supports server_error', async () => {
    const { provider } = makeProvider();
    const { state, nonce } = await pendingState(provider, { state: undefined });
    const url = new URL(await provider.denyAuthorization(state, 'server_error', nonce));
    expect(url.searchParams.get('error')).toBe('server_error');
    expect(url.searchParams.has('state')).toBe(false);
    expect(url.searchParams.get('iss')).toBe('https://mcp.example.com/');
  });

  it('denyAuthorization throws for an unknown state', async () => {
    const { provider } = makeProvider();
    await expect(provider.denyAuthorization('bogus', 'access_denied', 'nonce')).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it.each([
    ['the YNAB code exchange', () => exchangeCodeMock.mockRejectedValueOnce(new Error('exchange failed'))],
    ['the YNAB user lookup', () => getYnabUserIdMock.mockRejectedValueOnce(new Error('user lookup failed'))],
  ])('a failure in %s redirects server_error with iss and saves no user', async (_label, arrange) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    const { provider, storage } = makeProvider();
    const { state, nonce } = await pendingState(provider);
    const url = new URL(await provider.handleYnabCallback('ynabcode', state, nonce));
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

describe('McpOAuthProvider refresh downscoping (read-write implies read-only)', () => {
  it('narrows a read-write-only grant to a read-only access token; the refresh token keeps the grant', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { scopes: ['read-write'] });
    expect((await provider.verifyAccessToken(tokens.access_token)).extra?.['grantedScope']).toBe('read-write');

    const narrowed = await provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-only']);
    expect(narrowed.scope).toBe('read-only');
    // The stored access level is read-only, not just the reported one.
    expect((await storage.getAccessToken(narrowed.access_token))?.grantedScope).toBe('read-only');
    const info = await provider.verifyAccessToken(narrowed.access_token);
    expect(info.scopes).toEqual(['read-only']);
    expect(info.extra?.['grantedScope']).toBe('read-only');
    // RFC 6749 section 6: the rotated refresh token carries the original grant.
    expect(await storage.getRefreshToken(refreshOf(narrowed))).toMatchObject({
      scopes: ['read-write'],
      grantedScope: 'read-write',
    });

    const restored = await provider.exchangeRefreshToken(client, refreshOf(narrowed));
    expect(restored.scope).toBe('read-write');
    expect((await provider.verifyAccessToken(restored.access_token)).extra?.['grantedScope']).toBe('read-write');
  });

  it('still rejects an unknown scope alongside read-only', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { scopes: ['read-write'] });
    await expect(
      provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-only', 'admin'])
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it('does not widen a read-only grant', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { scopes: ['read-only'] });
    await expect(
      provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-write'])
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });
});

describe('McpOAuthProvider refresh validation (before the token is spent)', () => {
  it('rejects an unknown refresh token with invalid_grant', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await expect(provider.exchangeRefreshToken(client, 'no-such-token')).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });

  it('an invalid scope leaves the refresh token usable', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider, { scopes: ['read-only'] });
    const err = await errorOf(provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-write']));
    expect(err).toBeInstanceOf(InvalidScopeError);
    expect(await storage.getRefreshToken(refreshOf(tokens))).toBeDefined();
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).resolves.toHaveProperty(
      'access_token'
    );
  });

  it('a stale resource binding is rejected without spending the refresh token', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveRefreshToken({
      token: 'stale-rt',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      scopes: [],
      resource: 'https://old.example.com/mcp',
    });
    const take = vi.spyOn(storage, 'rotateRefreshToken');
    await expect(provider.exchangeRefreshToken(client, 'stale-rt')).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(take).not.toHaveBeenCalled();
    expect(await storage.getRefreshToken('stale-rt')).toBeDefined();
  });

  it('a refresh token presented by another client is revoked', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const other = await provider.clientsStore.registerClient(clientMetadata);
    const err = await errorOf(provider.exchangeRefreshToken(other, refreshOf(tokens)));
    expect(err).toBeInstanceOf(InvalidGrantError);
    // Generic: does not confirm the token is valid for some other client.
    expect((err as InvalidGrantError).message).toBe('Invalid refresh token');
    expect(await storage.getRefreshToken(refreshOf(tokens))).toBeUndefined();
    // Not even its own client can use it any more.
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });

  it('issues nothing when a concurrent request spent the token between lookup and take', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    vi.spyOn(storage, 'rotateRefreshToken').mockResolvedValueOnce(undefined);
    const saveAccess = vi.spyOn(storage, 'saveAccessToken');
    const saveRefresh = vi.spyOn(storage, 'saveRefreshToken');
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(saveAccess).not.toHaveBeenCalled();
    expect(saveRefresh).not.toHaveBeenCalled();
  });

  it('two concurrent refreshes with one token: exactly one succeeds, then the loser revokes the family', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const results = await Promise.allSettled([
      provider.exchangeRefreshToken(client, refreshOf(tokens)),
      provider.exchangeRefreshToken(client, refreshOf(tokens)),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(InvalidGrantError);
    // The loser looks like reuse (RFC 9700): the winner's new pair is revoked.
    const winner = won[0]?.status === 'fulfilled' ? won[0].value : undefined;
    if (!winner) throw new Error('expected a winner');
    await expect(provider.verifyAccessToken(winner.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(client, refreshOf(winner))).rejects.toBeInstanceOf(
      InvalidGrantError
    );
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

// ---------------------------------------------------------------------------
// Browser binding (consent cookie): the confused-deputy defense
// ---------------------------------------------------------------------------

describe('McpOAuthProvider consent cookie', () => {
  async function consent(
    provider: McpOAuthProvider,
    params: Partial<AuthorizationParams> = {}
  ): Promise<{ state: string; nonce: string; html: string; res: FakeRes }> {
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, { ...authParams, ...params }, res as unknown as Response);
    return { ...consentOf(res), res };
  }

  it('sets a __Host- cookie and stores only the nonce hash on the pending auth', async () => {
    const { provider, storage } = makeProvider();
    const save = vi.spyOn(storage, 'savePendingAuth');
    const { state, nonce, res } = await consent(provider);

    const set = setCookieOf(res);
    expect(set.startsWith(`${provider.consentCookie.name(state)}=${nonce};`)).toBe(true);
    expect(set).toMatch(/^__Host-/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Max-Age=600');

    const saved = save.mock.calls[0]?.[0];
    expect(saved?.browserBinding).toBeTruthy();
    expect(saved?.browserBinding).not.toBe(nonce);
    expect(JSON.stringify(saved)).not.toContain(nonce);
  });

  it('shows the redirect URI and forbids framing the consent page', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient({
      ...clientMetadata,
      redirect_uris: ['https://attacker.example/cb?x=<b>'],
    });
    const res = makeRes();
    await provider.authorize(
      client,
      { ...authParams, redirectUri: 'https://attacker.example/cb?x=<b>' },
      res as unknown as Response
    );
    const html = res.send.mock.calls[0]?.[0] as string;
    expect(html).toContain('https://attacker.example/cb?x=&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', "frame-ancestors 'none'");
    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });

  it('start without the cookie fails, and the state is then spent', async () => {
    const { provider } = makeProvider();
    const { state, nonce } = await consent(provider);
    await expect(provider.startYnabAuthorization(state, 'read-write', undefined)).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    await expect(provider.startYnabAuthorization(state, 'read-write', nonce)).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });

  it("start with another authorization's cookie fails", async () => {
    const { provider } = makeProvider();
    const attacker = await consent(provider);
    const victim = await consent(provider);
    await expect(
      provider.startYnabAuthorization(attacker.state, 'read-write', victim.nonce)
    ).rejects.toBeInstanceOf(InvalidGrantError);
    // The victim's own authorization is unaffected.
    await expect(provider.startYnabAuthorization(victim.state, 'read-only', victim.nonce)).resolves.toContain(
      'app.ynab.com'
    );
  });

  it('two authorizations in one browser each keep their own cookie', async () => {
    const { provider } = makeProvider();
    const a = await consent(provider);
    const b = await consent(provider);
    expect(provider.consentCookie.name(a.state)).not.toBe(provider.consentCookie.name(b.state));
    await provider.startYnabAuthorization(a.state, 'read-only', a.nonce);
    await provider.startYnabAuthorization(b.state, 'read-only', b.nonce);
    expect(new URL(await provider.handleYnabCallback('c1', a.state, a.nonce)).searchParams.has('code')).toBe(true);
    expect(new URL(await provider.handleYnabCallback('c2', b.state, b.nonce)).searchParams.has('code')).toBe(true);
  });

  it('callback without the cookie never exchanges the YNAB code or saves a user', async () => {
    const { provider, storage } = makeProvider();
    // Attacker ran consent and start in their own browser, then got the victim
    // to approve at YNAB: the victim's browser arrives with no consent cookie.
    const { state, nonce } = await consent(provider);
    await provider.startYnabAuthorization(state, 'read-write', nonce);
    await expect(provider.handleYnabCallback('victim-code', state, undefined)).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(exchangeCodeMock).not.toHaveBeenCalled();
    expect(await storage.getUser('ynab-user-1')).toBeUndefined();
    // And the state is spent.
    await expect(provider.handleYnabCallback('victim-code', state, nonce)).rejects.toThrow();
  });

  it('callback with a wrong cookie value fails', async () => {
    const { provider } = makeProvider();
    const { state, nonce } = await consent(provider);
    await provider.startYnabAuthorization(state, 'read-only', nonce);
    await expect(provider.handleYnabCallback('code', state, `${nonce}x`)).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('cancel without the cookie fails and returns no redirect', async () => {
    const { provider } = makeProvider();
    const { state } = await consent(provider);
    await expect(provider.denyAuthorization(state, 'access_denied', undefined)).rejects.toBeInstanceOf(
      InvalidGrantError
    );
  });

  it('a pending auth with no browser binding (pre-0.4.0) is never usable', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.savePendingAuth({
      state: 'legacy-state',
      clientId: client.client_id,
      redirectUri: 'https://client/cb',
      codeChallenge: 'chal',
      clientState: undefined,
      scopes: [],
      grantedScope: 'read-write',
      expiresAt: Date.now() + 60_000,
    });
    await expect(provider.handleYnabCallback('code', 'legacy-state', 'anything')).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('over http (loopback) the cookie has no __Host- prefix and no Secure', async () => {
    const { provider } = makeProvider({ publicUrl: 'http://localhost:3000' });
    const { res } = await consent(provider);
    const set = setCookieOf(res);
    expect(set.startsWith('ynab_mcp_consent_')).toBe(true);
    expect(set).not.toContain('Secure');
  });
});

// ---------------------------------------------------------------------------
// Per-grant access level (read-only / read-write)
// ---------------------------------------------------------------------------

describe('McpOAuthProvider per-grant access level', () => {
  async function tokensFor(
    provider: McpOAuthProvider,
    choice: 'read-only' | 'read-write',
    params: Partial<AuthorizationParams> = {}
  ): Promise<{ client: OAuthClientInformationFull; tokens: OAuthTokens }> {
    const { client, code } = await driveToAuthCode(provider, choice, params);
    await provider.challengeForAuthorizationCode(client, code);
    return { client, tokens: await provider.exchangeAuthorizationCode(client, code) };
  }

  async function accessOf(provider: McpOAuthProvider, accessToken: string): Promise<unknown> {
    return (await provider.verifyAccessToken(accessToken)).extra?.['grantedScope'];
  }

  it("a later read-write consent by the same user does not widen another client's read-only grant", async () => {
    const { provider, storage } = makeProvider();
    const a = await tokensFor(provider, 'read-only');
    const b = await tokensFor(provider, 'read-write');

    // The user record follows the latest consent...
    expect((await storage.getUser('ynab-user-1'))?.grantedScope).toBe('read-write');
    // ...but each token keeps its own grant.
    expect(await accessOf(provider, a.tokens.access_token)).toBe('read-only');
    expect(await accessOf(provider, b.tokens.access_token)).toBe('read-write');

    // Refresh keeps A read-only, even with no scope requested.
    const rotated = await provider.exchangeRefreshToken(a.client, refreshOf(a.tokens));
    expect(await accessOf(provider, rotated.access_token)).toBe('read-only');
    expect((await storage.takeRefreshToken(refreshOf(rotated)))?.grantedScope).toBe('read-only');
  });

  it('records the grant on the code and both tokens', async () => {
    const { provider, storage } = makeProvider();
    const save = vi.spyOn(storage, 'saveAuthCode');
    const { tokens } = await tokensFor(provider, 'read-write');
    expect(save.mock.calls[0]?.[0].grantedScope).toBe('read-write');
    expect((await storage.getAccessToken(tokens.access_token))?.grantedScope).toBe('read-write');
    expect((await storage.takeRefreshToken(refreshOf(tokens)))?.grantedScope).toBe('read-write');
  });

  it('a read-only grant reports a requested read-write scope as read-only', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await tokensFor(provider, 'read-only', { scopes: ['read-write'] });
    expect(tokens.scope).toBe('read-only');
    expect(await accessOf(provider, tokens.access_token)).toBe('read-only');
    await expect(
      provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-write'])
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it('a client that requests only read-only is not offered, nor granted, write access', async () => {
    const { provider } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const res = makeRes();
    await provider.authorize(client, { ...authParams, scopes: ['read-only'] }, res as unknown as Response);
    const { state, nonce, html } = consentOf(res);
    expect(html).not.toContain('scope=read-write');
    const url = await provider.startYnabAuthorization(state, 'read-write', nonce);
    expect(new URL(url).searchParams.get('scope')).toBe('read-only');
    const code = new URL(await provider.handleYnabCallback('c', state, nonce)).searchParams.get('code') ?? '';
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(await accessOf(provider, tokens.access_token)).toBe('read-only');
  });

  it('an access token narrowed to read-only on refresh is read-only', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await tokensFor(provider, 'read-write', {
      scopes: ['read-only', 'read-write'],
    });
    expect(await accessOf(provider, tokens.access_token)).toBe('read-write');
    const narrowed = await provider.exchangeRefreshToken(client, refreshOf(tokens), ['read-only']);
    expect(await accessOf(provider, narrowed.access_token)).toBe('read-only');
  });

  it('a read-write grant with no recognized scopes is read-write', async () => {
    const { provider } = makeProvider();
    const { tokens } = await tokensFor(provider, 'read-write', { scopes: ['ynab'] });
    expect(await accessOf(provider, tokens.access_token)).toBe('read-write');
  });

  it('treats a pre-0.4.0 access token (no grant recorded) as read-only', async () => {
    const { provider, storage } = makeProvider();
    await storage.upsertUser({
      userId: 'ynab-user-1',
      grantedScope: 'read-write',
      encryptedRefreshToken: 'x',
      updatedAt: Date.now(),
    });
    await storage.saveAccessToken({
      token: 'legacy-at',
      clientId: 'c1',
      userId: 'ynab-user-1',
      scopes: ['read-write'],
      expiresAt: Date.now() + 60_000,
    });
    expect(await accessOf(provider, 'legacy-at')).toBe('read-only');
  });

  it('a pre-0.4.0 refresh token or code yields read-only tokens', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveRefreshToken({
      token: 'legacy-rt',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      scopes: [],
    });
    const fromRefresh = await provider.exchangeRefreshToken(client, 'legacy-rt');
    expect(await accessOf(provider, fromRefresh.access_token)).toBe('read-only');
    expect((await storage.takeRefreshToken(refreshOf(fromRefresh)))?.grantedScope).toBe('read-only');

    await storage.saveAuthCode({
      code: 'legacy-code',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      redirectUri: 'https://client/cb',
      codeChallenge: 'chal',
      scopes: [],
      expiresAt: Date.now() + 60_000,
    });
    await provider.challengeForAuthorizationCode(client, 'legacy-code');
    const fromCode = await provider.exchangeAuthorizationCode(client, 'legacy-code');
    expect(await accessOf(provider, fromCode.access_token)).toBe('read-only');
  });
});

// ---------------------------------------------------------------------------
// Refresh-token families and reuse detection (RFC 9700 section 4.14.2)
// ---------------------------------------------------------------------------

describe('McpOAuthProvider refresh-token reuse detection', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  /** A further grant for an already-registered client (a new code, so a new family). */
  async function grantFor(provider: McpOAuthProvider, client: OAuthClientInformationFull): Promise<OAuthTokens> {
    const res = makeRes();
    await provider.authorize(client, authParams, res as unknown as Response);
    const { state, nonce } = consentOf(res);
    await provider.startYnabAuthorization(state, 'read-write', nonce);
    const code = new URL(await provider.handleYnabCallback('ynabcode', state, nonce)).searchParams.get('code') ?? '';
    await provider.challengeForAuthorizationCode(client, code);
    return provider.exchangeAuthorizationCode(client, code);
  }

  /** Assert every token of `pairs` is dead: access tokens fail to verify, refresh tokens to refresh. */
  async function expectRevoked(
    provider: McpOAuthProvider,
    client: OAuthClientInformationFull,
    ...pairs: OAuthTokens[]
  ): Promise<void> {
    for (const pair of pairs) {
      await expect(provider.verifyAccessToken(pair.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
      await expect(provider.exchangeRefreshToken(client, refreshOf(pair))).rejects.toBeInstanceOf(
        InvalidGrantError
      );
    }
  }

  it('tags every token of a grant, across refreshes, with one family; each code starts a new one', async () => {
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const familyId = (await storage.getAccessToken(tokens.access_token))?.familyId;
    expect(familyId).toEqual(expect.any(String));
    expect((await storage.getRefreshToken(refreshOf(tokens)))?.familyId).toBe(familyId);

    const rotated = await provider.exchangeRefreshToken(client, refreshOf(tokens));
    expect((await storage.getAccessToken(rotated.access_token))?.familyId).toBe(familyId);
    expect((await storage.getRefreshToken(refreshOf(rotated)))?.familyId).toBe(familyId);

    const second = await grantFor(provider, client);
    const secondFamily = (await storage.getAccessToken(second.access_token))?.familyId;
    expect(secondFamily).toEqual(expect.any(String));
    expect(secondFamily).not.toBe(familyId);
  });

  it('replaying a rotated refresh token revokes the whole family', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const first = await provider.exchangeRefreshToken(client, refreshOf(tokens));
    const second = await provider.exchangeRefreshToken(client, refreshOf(first));

    // The attacker (or a confused client) replays the first, long-rotated token.
    const err = await errorOf(provider.exchangeRefreshToken(client, refreshOf(tokens)));
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect((err as Error).message).toBe('Invalid refresh token');

    // The current pair, and every earlier access token, is now dead.
    await expectRevoked(provider, client, second);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.verifyAccessToken(first.access_token)).rejects.toBeInstanceOf(InvalidTokenError);

    // Logged for the operator, without the token.
    expect(errorSpy).toHaveBeenCalledWith('[OAuth] Refresh token reuse detected; revoked its token family');
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(refreshOf(tokens));
  });

  it('a replay after the legitimate client already rotated again still revokes the newest pair', async () => {
    // The attacker used the stolen token first; the legitimate client's later
    // refresh with the same token is the replay, and kills the attacker's chain.
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const attacker = await provider.exchangeRefreshToken(client, refreshOf(tokens));
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    await expectRevoked(provider, client, attacker);
  });

  it('answers a reused token exactly like an unknown one', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    await provider.exchangeRefreshToken(client, refreshOf(tokens));

    const reused = await errorOf(provider.exchangeRefreshToken(client, refreshOf(tokens)));
    const unknown = await errorOf(provider.exchangeRefreshToken(client, 'never-issued'));
    expect(reused).toBeInstanceOf(InvalidGrantError);
    expect(unknown).toBeInstanceOf(InvalidGrantError);
    expect((reused as InvalidGrantError).toResponseObject()).toEqual(
      (unknown as InvalidGrantError).toResponseObject()
    );
    expect((reused as InvalidGrantError).toResponseObject()).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid refresh token',
    });
  });

  it("leaves the user's other families alone, for the same client and for another client", async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const sameClient = await grantFor(provider, client);
    const other = await driveToTokens(provider);
    await provider.exchangeRefreshToken(client, refreshOf(tokens));

    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
      InvalidGrantError
    );

    for (const [c, pair] of [
      [client, sameClient],
      [other.client, other.tokens],
    ] as const) {
      await expect(provider.verifyAccessToken(pair.access_token)).resolves.toMatchObject({
        extra: { userId: 'ynab-user-1' },
      });
      await expect(provider.exchangeRefreshToken(c, refreshOf(pair))).resolves.toHaveProperty('access_token');
    }
  });

  it(`keeps a tombstone for ${REFRESH_TOKEN_REUSE_WINDOW_MS / 86_400_000} days, then a replay just fails`, async () => {
    expect(REFRESH_TOKEN_REUSE_WINDOW_MS).toBe(30 * 24 * 3600_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const rotatedAt = Date.now();
    const rotated = await provider.exchangeRefreshToken(client, refreshOf(tokens));
    expect(await storage.getConsumedRefreshToken(refreshOf(tokens))).toMatchObject({
      clientId: client.client_id,
      expiresAt: rotatedAt + REFRESH_TOKEN_REUSE_WINDOW_MS,
    });

    // Past the window the replay is an unknown token: refused, nothing revoked.
    vi.setSystemTime(rotatedAt + REFRESH_TOKEN_REUSE_WINDOW_MS + 1);
    const del = vi.spyOn(storage, 'deleteTokenFamily');
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(del).not.toHaveBeenCalled();
    await expect(provider.exchangeRefreshToken(client, refreshOf(rotated))).resolves.toHaveProperty(
      'access_token'
    );
  });

  it('prunes expired tombstones on the next rotation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { provider, storage } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const t0 = Date.now();
    const rotated = await provider.exchangeRefreshToken(client, refreshOf(tokens));

    vi.setSystemTime(t0 + REFRESH_TOKEN_REUSE_WINDOW_MS + 1);
    await provider.exchangeRefreshToken(client, refreshOf(rotated));

    // Back inside the first tombstone's window it would still be readable, had
    // it not been pruned; the second tombstone is kept.
    vi.setSystemTime(t0);
    expect(await storage.getConsumedRefreshToken(refreshOf(tokens))).toBeUndefined();
    vi.setSystemTime(t0 + REFRESH_TOKEN_REUSE_WINDOW_MS + 1);
    expect(await storage.getConsumedRefreshToken(refreshOf(rotated))).toBeDefined();
  });

  it('a refresh token presented by another client takes its family with it', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const other = await provider.clientsStore.registerClient(clientMetadata);
    await expect(provider.exchangeRefreshToken(other, refreshOf(tokens))).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    await expectRevoked(provider, client, tokens);
  });

  it('/revoke of a refresh token revokes its family', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    const rotated = await provider.exchangeRefreshToken(client, refreshOf(tokens));
    const unrelated = await grantFor(provider, client);

    await provider.revokeToken(client, { token: refreshOf(rotated) });

    await expectRevoked(provider, client, rotated);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.verifyAccessToken(unrelated.access_token)).resolves.toBeDefined();
    await expect(provider.exchangeRefreshToken(client, refreshOf(unrelated))).resolves.toHaveProperty(
      'access_token'
    );
  });

  it('/revoke of an access token revokes only that token', async () => {
    const { provider } = makeProvider();
    const { client, tokens } = await driveToTokens(provider);
    await provider.revokeToken(client, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(client, refreshOf(tokens))).resolves.toHaveProperty(
      'access_token'
    );
  });

  it('a 0.3.x refresh token (no family) refreshes into a new family that its replay revokes', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    await storage.saveRefreshToken({
      token: 'legacy-rt',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      scopes: ['read-only'],
    });
    const rotated = await provider.exchangeRefreshToken(client, 'legacy-rt');
    const familyId = (await storage.getAccessToken(rotated.access_token))?.familyId;
    expect(familyId).toEqual(expect.any(String));
    expect((await storage.getRefreshToken(refreshOf(rotated)))?.familyId).toBe(familyId);
    expect((await storage.getConsumedRefreshToken('legacy-rt'))?.familyId).toBe(familyId);

    await expect(provider.exchangeRefreshToken(client, 'legacy-rt')).rejects.toBeInstanceOf(InvalidGrantError);
    await expectRevoked(provider, client, rotated);
  });

  it('a 0.3.x refresh token spent before the upgrade (no tombstone) just fails; /revoke of one deletes only it', async () => {
    const { provider, storage } = makeProvider();
    const client = await provider.clientsStore.registerClient(clientMetadata);
    const legacyAt = {
      token: 'legacy-at',
      clientId: client.client_id,
      userId: 'ynab-user-1',
      scopes: [],
      expiresAt: Date.now() + 60_000,
    };
    await storage.saveAccessToken(legacyAt);
    const del = vi.spyOn(storage, 'deleteTokenFamily');
    await expect(provider.exchangeRefreshToken(client, 'spent-by-0.3.x')).rejects.toBeInstanceOf(
      InvalidGrantError
    );
    expect(del).not.toHaveBeenCalled();

    await storage.saveRefreshToken({ token: 'legacy-rt', clientId: client.client_id, userId: 'ynab-user-1', scopes: [] });
    await provider.revokeToken(client, { token: 'legacy-rt' });
    expect(await storage.getRefreshToken('legacy-rt')).toBeUndefined();
    expect(del).not.toHaveBeenCalled();
    await expect(provider.verifyAccessToken('legacy-at')).resolves.toBeDefined();
  });
});
