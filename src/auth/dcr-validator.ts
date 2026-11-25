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
 *
 * {@link registrableMetadata} is the rule itself. Client ID Metadata Documents
 * (#46, client-id-metadata.ts) use it too, so a fetched document is held to
 * exactly what a registration is.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { validateClientMetadata, type ClientMetadataError, type ClientMetadataPolicy } from './client-metadata.js';

/** What a registration (or a metadata document) leaves for the library: the kept fields, normalized. */
export type RegistrableMetadata =
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; error: ClientMetadataError };

/**
 * Check client metadata against this server's rules and keep only what the
 * library may see. `sector_identifier_uri` is refused, not dropped, so the
 * client learns it isn't honored: pairwise subjects are off, and the library
 * would fetch the URL the client named (#113's third note).
 */
export function registrableMetadata(body: unknown, policy: ClientMetadataPolicy): RegistrableMetadata {
  if (body !== null && typeof body === 'object' && 'sector_identifier_uri' in body) {
    return {
      ok: false,
      error: { error: 'invalid_client_metadata', error_description: 'sector_identifier_uri is not supported' },
    };
  }
  const result = validateClientMetadata(body, policy);
  if (!result.ok) return result;
  // The library's client `scope` names its own (OIDC) scopes, which ours aren't: a registered
  // `scope` would be refused. Ours are resource scopes (D2), asked for at /authorize; the
  // SDK never limited a client by it. Dropped, as M4 drops it from converted clients.
  const { scope: _scope, ...metadata } = result.metadata as Record<string, unknown>;
  return { ok: true, metadata };
}

export function dcrValidator(policy: ClientMetadataPolicy): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const result = registrableMetadata(req.body, policy);
    if (!result.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json(result.error);
      return;
    }
    req.body = result.metadata;
    next();
  };
}
