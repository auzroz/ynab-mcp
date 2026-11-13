/**
 * Client authentication for /token and /revoke against hashed client secrets (#52).
 *
 * DCR client secrets are stored as `s256.<hex>` and `getClient` returns that
 * hash as `client_secret`. The SDK's own client check, inside sdk-router,
 * compares the presented secret to it with `!==`, which no real secret passes.
 * So this stage, mounted ahead of sdk-router and behind the route limiter (gate
 * G21), does the real check for a confidential client:
 *
 *   - a presented value in the hash's format (`s256.` anything) is refused, so
 *     a hash copied out of the database is never a credential;
 *   - the presented secret's SHA-256 is compared to the stored hash with
 *     `timingSafeEqual`, and `client_secret_expires_at` is enforced;
 *   - on success the stored hash is written into `req.body.client_secret`, so
 *     the SDK's comparison passes.
 *
 * It fails closed: if this stage were not mounted, every confidential client
 * would get `invalid_client`. Public clients (no secret) pass through unchanged,
 * and so does a request the SDK rejects before any client lookup (no
 * `client_id`, or a non-string `client_secret`). Every refusal is the SDK's own
 * `invalid_client` response (status 400, as the SDK sends it); nothing about the
 * presented or stored values is logged or returned.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InvalidClientError, ServerError } from '@modelcontextprotocol/server-legacy/auth';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/server-legacy/auth';
import { verifyClientSecret } from './token-hash.js';

function refuse(res: Response, description: string): void {
  res.status(400).json(new InvalidClientError(description).toResponseObject());
}

/** The client-auth stage for a route whose SDK handler authenticates clients. */
export function clientAuthentication(clientsStore: OAuthRegisteredClientsStore): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Preflight and wrong-method requests are the SDK's to answer (CORS, 405).
    if (req.method !== 'POST') {
      next();
      return;
    }
    const body: unknown = req.body;
    const fields = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const clientId = fields['client_id'];
    const presented = fields['client_secret'];
    // The SDK refuses these with invalid_request before it looks up a client.
    if (typeof clientId !== 'string' || (presented !== undefined && typeof presented !== 'string')) {
      next();
      return;
    }

    let client: Awaited<ReturnType<OAuthRegisteredClientsStore['getClient']>>;
    try {
      client = await clientsStore.getClient(clientId);
    } catch {
      // Generic on purpose: storage errors can carry connection details.
      res.status(500).json(new ServerError('Internal Server Error').toResponseObject());
      return;
    }
    if (!client) {
      refuse(res, 'Invalid client_id');
      return;
    }
    // A public client: nothing to verify, and the SDK sees exactly what was sent.
    if (!client.client_secret) {
      next();
      return;
    }
    if (presented === undefined || presented === '') {
      refuse(res, 'Client secret is required');
      return;
    }
    if (!verifyClientSecret(presented, client.client_secret)) {
      refuse(res, 'Invalid client_secret');
      return;
    }
    const expiresAt = client.client_secret_expires_at;
    if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) {
      refuse(res, 'Client secret has expired');
      return;
    }
    // Verified: hand the SDK the one value its own comparison accepts.
    (fields as { client_secret?: string }).client_secret = client.client_secret;
    next();
  };
}
