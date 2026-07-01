/**
 * MCP OAuth 2.1 Authorization Server provider, federated to YNAB.
 *
 * Implements the SDK's `OAuthServerProvider` so `mcpAuthRouter` can expose
 * `/authorize`, `/token`, `/register` (Dynamic Client Registration) and `/revoke`
 * to MCP clients (claude.ai / Claude Desktop) with PKCE. The *user authorization*
 * step is delegated to YNAB: `authorize()` shows a read-only/read-write consent
 * page, then the browser is sent to YNAB; the `/oauth/ynab/callback` route
 * (wired in http.ts, which calls {@link McpOAuthProvider.handleYnabCallback})
 * exchanges the YNAB code, records the YNAB-identified user + encrypted refresh
 * token, and issues our own MCP authorization code back to the client.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Storage, GrantedScope } from '../storage/types.js';
import type { Encryptor } from '../crypto.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  getYnabUserId,
  type YnabOAuthConfig,
} from './ynab-oauth.js';

export interface McpProviderOptions {
  storage: Storage;
  encryptor: Encryptor;
  ynab: YnabOAuthConfig;
  /** Public base URL (no trailing slash), e.g. https://ynab-mcp.example.com */
  publicUrl: string;
  /** Whether read-write access may be offered at consent. */
  allowWrite: boolean;
  /** Force read-only regardless of the user's choice (defense in depth). */
  globalReadOnly: boolean;
  accessTokenTtlSec: number;
  authCodeTtlSec: number;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export class McpOAuthProvider implements OAuthServerProvider {
  private readonly opts: McpProviderOptions;
  // Bridges challengeForAuthorizationCode -> exchangeAuthorizationCode within a
  // single token request (the code is consumed from storage at challenge time).
  private readonly consumedCodes = new Map<
    string,
    { clientId: string; userId: string; redirectUri: string; codeChallenge: string; scopes: string[] }
  >();

  constructor(opts: McpProviderOptions) {
    this.opts = opts;
  }

  private get callbackUrl(): string {
    return `${this.opts.publicUrl}/oauth/ynab/callback`;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const storage = this.opts.storage;
    return {
      getClient: (clientId: string) => storage.getClient(clientId),
      registerClient: async (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await storage.saveClient(full);
        return full;
      },
    };
  }

  /**
   * Begin authorization: render the read-only/read-write consent page. The links
   * carry the pending-auth `state`; the chosen scope is applied at `/oauth/ynab/start`.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const state = newToken();
    await this.opts.storage.savePendingAuth({
      state,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      scopes: params.scopes ?? [],
      grantedScope: 'read-only',
      expiresAt: Date.now() + this.opts.authCodeTtlSec * 1000,
    });

    const startBase = `${this.opts.publicUrl}/oauth/ynab/start`;
    const roLink = `${startBase}?state=${encodeURIComponent(state)}&scope=read-only`;
    const rwLink = `${startBase}?state=${encodeURIComponent(state)}&scope=read-write`;
    const offerWrite = this.opts.allowWrite && !this.opts.globalReadOnly;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect YNAB</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
.btn{display:block;padding:.75rem 1rem;margin:.75rem 0;border:1px solid #ccc;border-radius:.5rem;text-decoration:none;color:#111}
.btn:hover{background:#f5f5f5}.muted{color:#666;font-size:.9rem}</style></head>
<body>
<h1>Connect your YNAB budget</h1>
<p>Client <code>${htmlEscape(client.client_name ?? client.client_id)}</code> is requesting access to your YNAB data. Choose the access level:</p>
<a class="btn" href="${htmlEscape(roLink)}"><strong>Read-only</strong><br><span class="muted">View budgets, accounts, and transactions. No changes.</span></a>
${offerWrite ? `<a class="btn" href="${htmlEscape(rwLink)}"><strong>Read &amp; write</strong><br><span class="muted">View and modify (create/update/delete) your budget data.</span></a>` : ''}
<p class="muted">You'll be sent to YNAB to authorize. You can disconnect at any time.</p>
</body></html>`);
  }

  /**
   * Called by the `/oauth/ynab/start` route: set the chosen scope and return the
   * YNAB authorize URL to redirect the browser to.
   */
  async startYnabAuthorization(state: string, scope: GrantedScope): Promise<string> {
    const rec = await this.opts.storage.takePendingAuth(state);
    if (!rec) throw new InvalidGrantError('Authorization request expired or invalid');
    const grantedScope: GrantedScope =
      this.opts.globalReadOnly || !this.opts.allowWrite ? 'read-only' : scope;
    await this.opts.storage.savePendingAuth({ ...rec, grantedScope });
    return buildAuthorizeUrl(this.opts.ynab, {
      redirectUri: this.callbackUrl,
      state,
      readOnly: grantedScope === 'read-only',
    });
  }

  /**
   * Called by the `/oauth/ynab/callback` route once YNAB redirects back with a
   * code. Returns the MCP client redirect URL (with our `code` + `state`).
   */
  async handleYnabCallback(code: string, state: string): Promise<string> {
    const rec = await this.opts.storage.takePendingAuth(state);
    if (!rec) throw new InvalidGrantError('Authorization request expired or invalid');

    const tokens = await exchangeCode(this.opts.ynab, {
      code,
      redirectUri: this.callbackUrl,
    });
    const userId = await getYnabUserId(tokens.accessToken, this.opts.ynab.endpoints);

    await this.opts.storage.upsertUser({
      userId,
      grantedScope: rec.grantedScope,
      encryptedRefreshToken: this.opts.encryptor.encrypt(tokens.refreshToken),
      updatedAt: Date.now(),
    });

    const mcpCode = newToken();
    await this.opts.storage.saveAuthCode({
      code: mcpCode,
      clientId: rec.clientId,
      userId,
      redirectUri: rec.redirectUri,
      codeChallenge: rec.codeChallenge,
      scopes: rec.scopes,
      expiresAt: Date.now() + this.opts.authCodeTtlSec * 1000,
    });

    const url = new URL(rec.redirectUri);
    url.searchParams.set('code', mcpCode);
    if (rec.clientState !== undefined) url.searchParams.set('state', rec.clientState);
    return url.toString();
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const rec = await this.opts.storage.takeAuthCode(authorizationCode);
    if (!rec) throw new InvalidGrantError('Invalid or expired authorization code');
    this.consumedCodes.set(authorizationCode, {
      clientId: rec.clientId,
      userId: rec.userId,
      redirectUri: rec.redirectUri,
      codeChallenge: rec.codeChallenge,
      scopes: rec.scopes,
    });
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const rec = this.consumedCodes.get(authorizationCode);
    this.consumedCodes.delete(authorizationCode);
    if (!rec) throw new InvalidGrantError('Invalid or expired authorization code');
    if (rec.clientId !== client.client_id) throw new InvalidGrantError('Client mismatch');
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    return this.issueTokens(rec.clientId, rec.userId, rec.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const rec = await this.opts.storage.takeRefreshToken(refreshToken);
    if (!rec) throw new InvalidGrantError('Invalid refresh token');
    if (rec.clientId !== client.client_id) throw new InvalidGrantError('Client mismatch');
    return this.issueTokens(rec.clientId, rec.userId, scopes && scopes.length ? scopes : rec.scopes);
  }

  private async issueTokens(clientId: string, userId: string, scopes: string[]): Promise<OAuthTokens> {
    const accessToken = newToken();
    const refreshToken = newToken();
    const expiresAt = Date.now() + this.opts.accessTokenTtlSec * 1000;
    await this.opts.storage.saveAccessToken({ token: accessToken, clientId, userId, scopes, expiresAt });
    await this.opts.storage.saveRefreshToken({ token: refreshToken, clientId, userId, scopes });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.opts.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = await this.opts.storage.getAccessToken(token);
    if (!rec) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      extra: { userId: rec.userId },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    try {
      await this.opts.storage.deleteAccessToken(request.token);
      await this.opts.storage.deleteRefreshToken(request.token);
    } catch (err) {
      throw new ServerError(err instanceof Error ? err.message : 'revoke failed');
    }
  }
}
