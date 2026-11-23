/**
 * The dcr-validator stage (#55a): dynamic client registration (RFC 7591) is
 * checked against this server's own rules (client-metadata.ts) ahead of the
 * registration handler (gate G21).
 *
 * A valid registration continues with only the kept fields, normalized; the
 * handler never sees a dropped field, so nothing it stores or returns holds
 * one. An invalid one is answered here with 400 and
 * `{ error: invalid_redirect_uri | invalid_client_metadata, error_description }`
 * (RFC 7591 section 3.2.2), with `no-store`. `sector_identifier_uri` is
 * refused outright (ADR-0002 D2). Other methods never get here: `cors-origin`
 * answers the preflight and `method-check` a wrong method.
 *
 * It runs ahead of oidc-provider's registration endpoint (ADR-0002 D8), which
 * then registers exactly the kept fields.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { validateClientMetadata, type ClientMetadataPolicy } from './client-metadata.js';

export function dcrValidator(policy: ClientMetadataPolicy): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    // Pairwise subjects are off, and the library would fetch the URL the client named
    // (#113's third note); refused, not dropped, so the client learns it isn't honored.
    const body: unknown = req.body;
    if (body !== null && typeof body === 'object' && 'sector_identifier_uri' in body) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'sector_identifier_uri is not supported' });
      return;
    }
    const result = validateClientMetadata(req.body, policy);
    if (!result.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json(result.error);
      return;
    }
    // The library's client `scope` names its own (OIDC) scopes, which ours aren't: a registered
    // `scope` would be refused. Ours are resource scopes (D2), asked for at /authorize; the
    // SDK never limited a client by it. Dropped, as M4 drops it from converted clients.
    const { scope: _scope, ...metadata } = result.metadata as Record<string, unknown>;
    req.body = metadata;
    next();
  };
}
