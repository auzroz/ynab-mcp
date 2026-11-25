/**
 * `resource` (RFC 8707) for clients registered on 0.5.0 or later (#64a,
 * OAUTH-22).
 *
 * **At `/authorize` it is required.** A client registered on 0.5.0 or later
 * must send it (authorize-validation.ts, step 6), while
 * `MCP_REQUIRE_RESOURCE` is on (the default; deprecated, removed in 0.6). A
 * missing one is `invalid_target` (RFC 8707 section 2: "missing"). That is
 * where the token's audience is decided: the grant is bound to the resource
 * the user authorized.
 *
 * **At `/token` it is optional for every client** (lead decision,
 * advisor-reviewed). A code exchange or refresh without `resource` gets the
 * grant's resource as its audience: the library's `useGrantedResource`, and
 * this server serves one resource, so the audience is always the authorized
 * one (#64a checked this for both grants). Requiring it there would let a
 * client that signed in cleanly fail at its first refresh, an hour later. A
 * `resource` that is sent must be the grant's (this server's, in any spelling
 * `isSameResource` accepts); another is `invalid_target`, answered by the
 * `resource-check` stage below before the library runs, so neither the code
 * nor the refresh token is spent. (The library refuses a foreign resource on
 * a refresh before consuming the token, but on a code exchange only after
 * consuming the code, which would make the corrected retry a replay that
 * revokes the grant.)
 *
 * **Which clients are "registered on 0.5.0 or later".** The marker is the
 * `client_id` itself, so no row needs a new field:
 *   - every 0.4.x registration got `crypto.randomUUID()` (the SDK-era
 *     `registerClient`, unchanged from the first OAuth release, 0.3.0, to
 *     0.4.3; 0.2.x had no OAuth server). M4 carried those rows over with their
 *     ids as they were (D12);
 *   - oidc-provider registers clients with its default `idFactory`, a 43
 *     character nanoid, and this server doesn't override it. A registration
 *     can't choose its own id (the library overwrites `client_id`);
 *   - #46's Client ID Metadata Documents identify a client by an https URL,
 *     which is new in 0.5.0, so it must send `resource` (lead decision). It
 *     needs nothing here: a URL is not a UUID. #46 resolves those clients
 *     through the same lookup authorize-validation uses, so step 6 applies.
 * A client misread as pre-0.5.0 only loses the `/authorize` requirement; its
 * tokens are still bound to this server's resource.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { InvalidTargetError, sendOAuthError } from './errors.js';
import { isSameResource } from './resource.js';

/** The `client_id` shape of every pre-0.5.0 registration: `crypto.randomUUID()` (lowercase). */
const PRE_050_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The description of a missing `resource` at `/authorize`. */
export const RESOURCE_REQUIRED_DESCRIPTION = 'The resource parameter is required';

/** The description of a `resource` this server doesn't serve (as authorize-guard's). */
export const FOREIGN_RESOURCE_DESCRIPTION = 'The requested resource is not served by this server';

/** Whether `clientId` was registered before 0.5.0 (see the file comment). */
export function registeredBefore050(clientId: string): boolean {
  return PRE_050_CLIENT_ID.test(clientId);
}

/**
 * Whether this client must send `resource` at `/authorize`: on with
 * `MCP_REQUIRE_RESOURCE` (the default), for every client but one registered
 * before 0.5.0. #46's URL-form (Client ID Metadata Document) ids are 0.5.0+
 * and must send it.
 */
export function clientMustSendResource(clientId: string, requireResource: boolean): boolean {
  return requireResource && !registeredBefore050(clientId);
}

/** One `resource` value that counts as sent. */
const NON_EMPTY_RESOURCE = z.string().min(1);

/**
 * An `/authorize` `resource` parameter that carries at least one value: a
 * non-empty string, or a list (a repeated parameter) with at least one. Other
 * members of a list don't make it missing; whether each value is this
 * server's is authorize-guard's check, not this one's.
 */
const AUTHORIZE_RESOURCE_SENT = z.union([
  NON_EMPTY_RESOURCE,
  z.array(z.unknown()).refine((values) => values.some((v) => NON_EMPTY_RESOURCE.safeParse(v).success)),
]);

/** Whether a request parameter carries at least one `resource` value. */
export function hasResource(value: unknown): boolean {
  return AUTHORIZE_RESOURCE_SENT.safeParse(value).success;
}

export interface ResourceCheckOptions {
  /** The canonical MCP resource: the grant's, since it is the only one this server serves. */
  resource: string;
}

/**
 * A `/token` request of a grant type that may name the resource (every one
 * this server serves). Anything else (another grant type, no body) is the
 * library's to refuse.
 */
const TOKEN_GRANT_REQUEST = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  resource: z.unknown().optional(),
});

/**
 * A `/token` `resource` that was sent: one string, or a list of strings (a
 * repeated parameter, or a JSON array). Anything else, a non-string member
 * included, can't be this server's resource.
 */
const TOKEN_RESOURCE = z.union([z.string(), z.array(z.string())]);

/**
 * The `resource-check` stage on `/token`: a `resource` that is sent must be
 * this server's (the grant's); a missing one goes on (the grant's resource
 * applies). It runs after `grant-guard`, so a replayed credential still
 * revokes its grant whatever resource it names, and before the library, so a
 * refused request spends nothing. Anything that isn't a grant of the two
 * kinds goes on: the library refuses it.
 */
export function resourceCheck({ resource }: ResourceCheckOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || req.path !== '/') {
      next();
      return;
    }
    // The grant type and the resource are parsed apart: a malformed resource
    // must be refused here, never passed on to the library (which would spend
    // the code first).
    const grant = TOKEN_GRANT_REQUEST.safeParse(req.body);
    if (!grant.success || grant.data.resource === undefined) {
      next();
      return;
    }
    const requested = TOKEN_RESOURCE.safeParse(grant.data.resource);
    const values = requested.success ? (Array.isArray(requested.data) ? requested.data : [requested.data]) : undefined;
    if (values === undefined || values.some((r) => !isSameResource(r, resource))) {
      sendOAuthError(res, new InvalidTargetError(FOREIGN_RESOURCE_DESCRIPTION));
      return;
    }
    next();
  };
}
