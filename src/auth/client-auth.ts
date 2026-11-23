/**
 * Client authentication for /token and /revoke against hashed client secrets
 * (#52, ADR-0002 D5).
 *
 * DCR client secrets are stored as `s256.<hex>` and the adapter
 * (src/auth/oidc/adapter.ts) returns that hash as `client_secret`. The
 * library's own client check, inside `as-library`, compares the presented
 * secret to it, which no real secret passes. So this stage, mounted ahead of
 * `as-library` and behind the route limiter (gate G21), does the real check
 * for a confidential client:
 *
 *   - a presented value in the hash's format (`s256.` anything) is refused, so
 *     a hash copied out of the database is never a credential;
 *   - the presented secret's SHA-256 is compared to the stored hash with
 *     `timingSafeEqual`, and `client_secret_expires_at` is enforced;
 *   - on success the stored hash is written into `req.body.client_secret`, so
 *     the library's comparison passes.
 *
 * It fails closed: if this stage were not mounted, every confidential client
 * would get `invalid_client`. An `Authorization` header is removed before the
 * library sees it: the library treats HTTP Basic and `client_secret_post` as
 * interchangeable and would compare a Basic secret with the stored hash
 * unchecked (#47-4). Public clients (no secret) pass through unchanged, and so
 * does a request without a `client_id` string or with a non-string
 * `client_secret` in the body: the library refuses those itself. Every
 * refusal from this stage is 400 `invalid_client`
 * with `no-store` (the library's own is 401, ADR-0002 D5); nothing about the
 * presented or stored values is logged or returned.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InvalidClientError, ServerError, sendOAuthError } from './errors.js';
import { verifyClientSecret } from './token-hash.js';

/** A registered client's metadata (RFC 7591 names), as the library holds it. */
export type ClientMetadata = Readonly<Record<string, unknown>>;

/** How the stages look a client up: undefined for an unknown one. */
export interface ClientLookup {
  getClient(clientId: string): Promise<ClientMetadata | undefined>;
}

function refuse(res: Response, description: string): void {
  sendOAuthError(res, new InvalidClientError(description));
}

/** The client-auth stage for a route whose library endpoint authenticates clients. */
export function clientAuthentication(clients: ClientLookup): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // method-check refuses everything else before this stage.
    if (req.method !== 'POST') {
      next();
      return;
    }
    // Only the body's credentials are checked here, so they are the only ones the library may
    // see: it would accept HTTP Basic for a client_secret_post client and compare the presented
    // value with the stored hash, so a hash copied out of the database would pass. The SDK never
    // read the header either.
    delete req.headers.authorization;
    const body: unknown = req.body;
    const fields = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const clientId = fields['client_id'];
    const presented = fields['client_secret'];
    // The library refuses these itself (invalid_request or invalid_client).
    if (typeof clientId !== 'string' || (presented !== undefined && typeof presented !== 'string')) {
      next();
      return;
    }

    let client: ClientMetadata | undefined;
    try {
      client = await clients.getClient(clientId);
    } catch {
      // Generic on purpose: storage errors can carry connection details.
      sendOAuthError(res, new ServerError('Internal Server Error'));
      return;
    }
    if (!client) {
      refuse(res, 'Invalid client_id');
      return;
    }
    const stored = client['client_secret'];
    // A public client: nothing to verify, and the library sees exactly what was sent.
    if (typeof stored !== 'string' || stored === '') {
      next();
      return;
    }
    if (presented === undefined || presented === '') {
      refuse(res, 'Client secret is required');
      return;
    }
    if (!verifyClientSecret(presented, stored)) {
      refuse(res, 'Invalid client_secret');
      return;
    }
    const expiresAt = client['client_secret_expires_at'];
    if (typeof expiresAt === 'number' && expiresAt !== 0 && expiresAt < Math.floor(Date.now() / 1000)) {
      refuse(res, 'Client secret has expired');
      return;
    }
    // Verified: hand the library the one value its own comparison accepts.
    (fields as { client_secret?: string }).client_secret = stored;
    next();
  };
}
