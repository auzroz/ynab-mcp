/**
 * The grant-guard stage on `/token` (ADR-0002 D6): RFC 9700 hardening the
 * library doesn't do, kept from the SDK-era provider.
 *
 * It looks the presented refresh token or code up with the library's own
 * public API, ignoring expiry (`RefreshToken.find(value, { ignoreExpiration:
 * true })`, `AuthorizationCode.find(...)`: the call the library's grant
 * handlers make), and revokes its whole grant (every token and code under
 * it, through storage) and answers `invalid_grant` before the library runs
 * when:
 *
 *   1. another client presents it, live or consumed. The library only
 *      refuses that ("client mismatch"); a leaked credential in another
 *      client's hands ends the family, as before the move;
 *   2. it was already consumed, whichever client presents it and whatever its
 *      age. The library checks expiry before `consumed`, so an expired and
 *      consumed credential would be refused without revoking its grant (the
 *      adapter keeps consumed rows for the D6 retention window, so the row is
 *      still there to find).
 *
 * A live credential presented by its own client goes on to the library, as
 * does anything the lookup doesn't find (the library answers `invalid_grant`).
 * It runs after `client-auth`, so the presenting client is a registered one
 * (and authenticated, for a confidential client); a request without a
 * `client_id` in the body is the library's to refuse. #64a's `refresh-guard`
 * runs before this stage, so an identical retry it answers never gets here.
 *
 * The response is a fixed `invalid_grant`, the same as for an unknown value.
 * A storage failure is a 500 `server_error`, logged sanitized.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type Provider from 'oidc-provider';
import { z } from 'zod';
import type { OAuthRowStore } from '../storage/types.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';
import { InvalidGrantError, ServerError, sendOAuthError } from './errors.js';

/** The library's own description for every refused grant (`errors.InvalidGrant`). */
export const INVALID_GRANT_DESCRIPTION = 'grant request is invalid';

export interface GrantGuardOptions {
  provider: Provider;
  /** Revokes a grant with everything under it (the adapter's `revokeByGrantId`). */
  store: Pick<OAuthRowStore, 'revokeOAuthGrant'>;
}

/** What the stage reads of a refresh token or code. */
interface GrantCredential {
  clientId?: string | undefined;
  grantId?: string | undefined;
  consumed?: unknown;
}

/** A credential value as presented: bounded (the library's are 43 characters). */
const CREDENTIAL = z.string().min(1).max(512);

/** The fields this stage reads of a `/token` request (client-auth has checked `client_id`). */
const GRANT_REQUEST = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('refresh_token'), client_id: z.string().min(1), refresh_token: CREDENTIAL }),
  z.object({ grant_type: z.literal('authorization_code'), client_id: z.string().min(1), code: CREDENTIAL }),
]);

function fieldsOf(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function grantGuard({ provider, store }: GrantGuardOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    // Anything that isn't a well-formed grant of the two kinds goes on: the library refuses it
    // (invalid_request, unsupported_grant_type or invalid_grant), and this stage has nothing to look up.
    const parsed = GRANT_REQUEST.safeParse(fieldsOf(req.body));
    if (!parsed.success) {
      next();
      return;
    }
    const grant = parsed.data;

    let found: GrantCredential | undefined;
    let label: string;
    const clientId = grant.client_id;
    try {
      if (grant.grant_type === 'refresh_token') {
        label = 'refresh token';
        found = await provider.RefreshToken.find(grant.refresh_token, { ignoreExpiration: true });
      } else {
        label = 'authorization code';
        found = await provider.AuthorizationCode.find(grant.code, { ignoreExpiration: true });
      }
    } catch (err) {
      console.error('[OAuth] grant-guard lookup failed:', sanitizeErrorMessage(err));
      sendOAuthError(res, new ServerError('Internal Server Error'));
      return;
    }
    if (found === undefined || typeof found.grantId !== 'string') {
      next();
      return;
    }

    const foreign = found.clientId !== clientId;
    const consumed = Boolean(found.consumed);
    if (!foreign && !consumed) {
      next();
      return;
    }

    try {
      await store.revokeOAuthGrant(found.grantId);
    } catch (err) {
      console.error('[OAuth] grant-guard could not revoke a grant:', sanitizeErrorMessage(err));
      sendOAuthError(res, new ServerError('Internal Server Error'));
      return;
    }
    console.error(
      `[OAuth] A ${foreign ? 'credential of another client' : 'consumed credential'} was presented at /token ` +
        `(${label}); revoked its grant`
    );
    sendOAuthError(res, new InvalidGrantError(INVALID_GRANT_DESCRIPTION));
  };
}
