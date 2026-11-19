/**
 * The dcr-validator stage (#55a): dynamic client registration (RFC 7591) is
 * checked against this server's own rules (client-metadata.ts) ahead of the
 * registration handler (gate G21).
 *
 * A valid registration continues with only the kept fields, normalized; the
 * handler never sees a dropped field, so nothing it stores or returns holds
 * one. An invalid one is answered here with 400 and
 * `{ error: invalid_redirect_uri | invalid_client_metadata, error_description }`
 * (RFC 7591 section 3.2.2), with `no-store`. Other methods (the CORS
 * preflight, a wrong method) go on to the handler, which answers them.
 *
 * It needs no handler internals, so it stays ahead of oidc-provider's
 * registration endpoint after #47-4 (ADR-0002 D8).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { validateClientMetadata, type ClientMetadataPolicy } from './client-metadata.js';

export function dcrValidator(policy: ClientMetadataPolicy): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const result = validateClientMetadata(req.body, policy);
    if (!result.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json(result.error);
      return;
    }
    req.body = result.metadata;
    next();
  };
}
