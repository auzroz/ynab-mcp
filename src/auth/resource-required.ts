/**
 * `resource` required for clients registered on 0.5.0 or later (#64a,
 * OAUTH-22; RFC 8707; the MCP authorization spec: the parameter "MUST be
 * included in both authorization requests and token requests").
 *
 * **Which clients.** A client registered before 0.5.0 keeps working without
 * `resource`: 0.4.x connectors were set up against a server that never asked
 * for it. Every other client must send it, at `/authorize`
 * (authorize-validation.ts) and on every `/token` request, the code exchange
 * and each refresh (the `resource-required` stage below).
 *
 * The marker is the `client_id` itself, so no row needs a new field:
 *   - every 0.4.x registration got `crypto.randomUUID()` (the SDK-era
 *     `registerClient`, unchanged from the first OAuth release, 0.3.x, to
 *     0.4.3). M4 carried those rows over with their ids as they were (D12);
 *   - oidc-provider registers clients with its default `idFactory`, a 43
 *     character nanoid, and this server doesn't override it. A registration
 *     can't choose its own id (the library overwrites `client_id`);
 *   - #46's Client ID Metadata Documents identify a client by an https URL,
 *     which is new in 0.5.0, so it must send `resource` (lead decision). It
 *     needs nothing here: a URL is not a UUID. If #46 adds a lookup of its
 *     own, it must go through {@link clientMustSendResource} too.
 * A client misread as pre-0.5.0 only loses this requirement; its tokens are
 * still bound to this server's resource (the library's default resource).
 *
 * `MCP_REQUIRE_RESOURCE=false` turns the requirement off for every client.
 * It is deprecated and removed in 0.6.
 *
 * A missing `resource` is `invalid_target` (RFC 8707 section 2: "missing").
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InvalidTargetError, sendOAuthError } from './errors.js';

/** The `client_id` shape of every pre-0.5.0 registration: `crypto.randomUUID()` (lowercase). */
const PRE_050_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The description of every refusal. */
export const RESOURCE_REQUIRED_DESCRIPTION = 'The resource parameter is required';

/** Whether `clientId` was registered before 0.5.0 (see the file comment). */
export function registeredBefore050(clientId: string): boolean {
  return PRE_050_CLIENT_ID.test(clientId);
}

/**
 * Whether this client must send `resource`: on with `MCP_REQUIRE_RESOURCE`
 * (the default), for every client but one registered before 0.5.0. #46's
 * URL-form (Client ID Metadata Document) ids are 0.5.0+ and must send it.
 */
export function clientMustSendResource(clientId: string, requireResource: boolean): boolean {
  return requireResource && !registeredBefore050(clientId);
}

/** Whether a request parameter carries at least one `resource` value. */
export function hasResource(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  return Array.isArray(value) && value.some((v) => typeof v === 'string' && v !== '');
}

export interface ResourceRequiredOptions {
  /** `MCP_REQUIRE_RESOURCE`. */
  requireResource: boolean;
}

/** The grant types whose `/token` request must name the resource (every one this server serves). */
const TOKEN_GRANTS = new Set(['authorization_code', 'refresh_token']);

function fieldsOf(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/**
 * The `resource-required` stage on `/token`. It runs after `client-auth`, so
 * the body's `client_id` is a registered (and, if confidential, authenticated)
 * client, and after `grant-guard`, so a replayed credential still revokes its
 * grant whatever else is missing. A request that isn't a grant of the two
 * kinds, or has no `client_id`, goes on: the library refuses it.
 */
export function resourceRequired({ requireResource }: ResourceRequiredOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!requireResource || req.method !== 'POST' || req.path !== '/') {
      next();
      return;
    }
    const body = fieldsOf(req.body);
    const grantType = body['grant_type'];
    const clientId = body['client_id'];
    if (typeof grantType !== 'string' || !TOKEN_GRANTS.has(grantType) || typeof clientId !== 'string') {
      next();
      return;
    }
    if (clientMustSendResource(clientId, requireResource) && !hasResource(body['resource'])) {
      sendOAuthError(res, new InvalidTargetError(RESOURCE_REQUIRED_DESCRIPTION));
      return;
    }
    next();
  };
}
