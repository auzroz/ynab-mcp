/**
 * The `/mcp` resource side over oidc-provider (ADR-0002 D10): the
 * `verifyAccessToken` the bearer stage calls, with WS7.3's contract.
 *
 * The token is looked up with `provider.AccessToken.find` (public API: one
 * adapter read, refused before any read when it isn't 43 base64url
 * characters; joined to its grant and its user, so a token whose grant was
 * revoked or whose user is gone or newer reads as unknown, STOR-1). It must be
 * unexpired and bound to the canonical resource exactly (`aud`).
 *
 * `AuthInfo`: `clientId`, the token's `scopes`, `expiresAt` (epoch seconds),
 * `resource`, and in `extra` the YNAB user id (`userId`, the library's
 * `accountId`), the access level (`grantedScope`: read-write only when the
 * scope includes `read-write`, D7) and the grant id (`grantId`, for #60's
 * audit). The user's own level (their YNAB grant, `YNAB_OAUTH_ALLOW_WRITE`,
 * `YNAB_READ_ONLY`) is still applied per request by http.ts.
 *
 * Every refusal, and every failure while verifying, is v2's
 * `OAuthError(InvalidToken)` with one fixed message, the only error the bearer
 * middleware answers with 401 and the `resource_metadata` challenge. A failure
 * is logged sanitized. Nothing is cached (ADR-0001 D7).
 */

import type Provider from 'oidc-provider';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { GrantedScope } from '../../storage/types.js';
import { InvalidTokenError } from '../errors.js';
import { sanitizeErrorMessage } from '../../utils/sanitize.js';

/** The one message of every refusal (as WS7.3's). */
export const INVALID_ACCESS_TOKEN = 'Invalid or expired access token';

export interface VerifierOptions {
  provider: Provider;
  /** The canonical MCP resource: the only audience accepted. */
  resource: string;
}

/** The access level a token's scope gives (D7): read-write only when it includes `read-write`. */
export function grantedScopeOf(scopes: ReadonlySet<string> | readonly string[]): GrantedScope {
  const has = Array.isArray(scopes) ? scopes.includes('read-write') : (scopes as ReadonlySet<string>).has('read-write');
  return has ? 'read-write' : 'read-only';
}

/** The `/mcp` verifier: what `mountAuthorizationServer` returns as `provider` after #47-4. */
export function createAccessTokenVerifier({ provider, resource }: VerifierOptions): OAuthTokenVerifier {
  const resourceUrl = new URL(resource);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let verified: AuthInfo | undefined;
      try {
        const found = typeof token === 'string' ? await provider.AccessToken.find(token) : undefined;
        const audience: unknown = found?.aud;
        const exp = found?.exp;
        if (
          found &&
          !found.isExpired &&
          audience === resource &&
          typeof found.accountId === 'string' &&
          found.accountId !== '' &&
          typeof found.clientId === 'string' &&
          typeof exp === 'number'
        ) {
          const scopes = [...found.scopes];
          verified = {
            token,
            clientId: found.clientId,
            scopes,
            expiresAt: exp,
            resource: resourceUrl,
            extra: {
              userId: found.accountId,
              grantedScope: grantedScopeOf(scopes),
              grantId: found.grantId,
            },
          };
        }
      } catch (err) {
        console.error('[OAuth] Access token verification failed; refused as invalid_token:', sanitizeErrorMessage(err));
      }
      if (verified === undefined) throw new InvalidTokenError(INVALID_ACCESS_TOKEN);
      return verified;
    },
  };
}
