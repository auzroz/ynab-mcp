/**
 * The `/mcp` resource side over oidc-provider (ADR-0002 D10): the
 * `verifyAccessToken` the bearer stage calls, with WS7.3's contract.
 *
 * The token is looked up with `provider.AccessToken.find` (public API: one
 * adapter read; a value that isn't 43 base64url characters is refused here,
 * by a Zod schema, before any read; joined to its grant and its user, so a token whose grant was
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
 * #64a: a verified token is passed to `firstUse` (refresh-grace.ts
 * `successorFirstUse`), which, in the token's first 60 s only, records the
 * first use of a rotation's successor so a retry of the spent refresh token
 * revokes again. Its failure is logged and never refuses the token.
 *
 * Every refusal, and every failure while verifying, is v2's
 * `OAuthError(InvalidToken)` with one fixed message, the only error the bearer
 * middleware answers with 401 and the `resource_metadata` challenge. A failure
 * is logged sanitized. Nothing is cached (ADR-0001 D7).
 */

import type Provider from 'oidc-provider';
import { z } from 'zod';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { GrantedScope } from '../../storage/types.js';
import { InvalidTokenError } from '../errors.js';
import { sanitizeErrorMessage } from '../../utils/sanitize.js';

/** An access token as the library issues it: 43 base64url characters. Anything else is refused unread. */
const ACCESS_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The one message of every refusal (as WS7.3's). */
export const INVALID_ACCESS_TOKEN = 'Invalid or expired access token';

export interface VerifierOptions {
  provider: Provider;
  /** The canonical MCP resource: the only audience accepted. */
  resource: string;
  /** #64a: told of every verified token: its value, and its grant id, `iat` (epoch seconds) and `gty`. */
  firstUse?: ((accessToken: string, claims: { grantId: unknown; iat: unknown; gty: unknown }) => Promise<void>) | undefined;
}

/** The access level a token's scope gives (D7): read-write only when it includes `read-write`. */
export function grantedScopeOf(scopes: ReadonlySet<string> | readonly string[]): GrantedScope {
  const has = Array.isArray(scopes) ? scopes.includes('read-write') : (scopes as ReadonlySet<string>).has('read-write');
  return has ? 'read-write' : 'read-only';
}

/** The `/mcp` verifier: what `mountAuthorizationServer` returns as `provider` after #47-4. */
export function createAccessTokenVerifier({ provider, resource, firstUse }: VerifierOptions): OAuthTokenVerifier {
  const resourceUrl = new URL(resource);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let verified: AuthInfo | undefined;
      let claims: { grantId: unknown; iat: unknown; gty: unknown } | undefined;
      try {
        const presented = ACCESS_TOKEN.safeParse(token);
        const found = presented.success ? await provider.AccessToken.find(presented.data) : undefined;
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
          claims = { grantId: found.grantId, iat: found.iat, gty: found.gty };
        }
      } catch (err) {
        console.error('[OAuth] Access token verification failed; refused as invalid_token:', sanitizeErrorMessage(err));
      }
      if (verified === undefined) throw new InvalidTokenError(INVALID_ACCESS_TOKEN);
      if (firstUse !== undefined && claims !== undefined) {
        try {
          await firstUse(token, claims);
        } catch (err) {
          console.error('[OAuth] Could not record a successor token\'s first use:', sanitizeErrorMessage(err));
        }
      }
      return verified;
    },
  };
}
