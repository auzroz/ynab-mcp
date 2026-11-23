/**
 * The protected-resource metadata documents (RFC 9728), served by our own
 * `metadata` stage (ADR-0002 D8: "the PRM routes: unchanged"), as the SDK's
 * `metadataHandler` served them: any-origin CORS, `GET` (and the CORS
 * preflight) only, anything else 405. The authorization server's own
 * discovery documents are the library's (`as-library`).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { methodCheck } from './method-check.js';

/** A preflight's `Access-Control-Request-Headers`: a bounded, comma-separated list of header names (RFC 9110 tokens). */
const REQUESTED_HEADERS = z
  .string()
  .max(1024)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\s*,\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/);

/**
 * Answer a CORS preflight: 204 with `Access-Control-Allow-Methods: methods`,
 * and the requested headers allowed when they parse as a header-name list
 * (otherwise none are). `Access-Control-Allow-Origin: *` is the caller's.
 */
export function answerPreflight(req: Request, res: Response, methods: string): void {
  res.setHeader('Access-Control-Allow-Methods', methods);
  const requested = REQUESTED_HEADERS.safeParse(req.header('access-control-request-headers'));
  if (requested.success) {
    res.setHeader('Access-Control-Allow-Headers', requested.data);
    res.setHeader('Vary', 'Access-Control-Request-Headers');
  }
  res.setHeader('Content-Length', '0');
  res.status(204).end();
}

/** The CORS answer of a metadata document: `*` on every response; a preflight is answered here (204). */
function openCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'OPTIONS') {
    next();
    return;
  }
  answerPreflight(req, res, 'GET, OPTIONS');
}

/** The handlers of a metadata route: CORS, the method check, then the document as JSON. */
export function metadataDocument(document: Readonly<Record<string, unknown>>): RequestHandler[] {
  const check = methodCheck(['GET', 'OPTIONS']);
  const send: RequestHandler = (req, res, next) => {
    // Only the document's own path: anything under it is not a document.
    if (req.path !== '/') {
      next();
      return;
    }
    res.status(200).json(document);
  };
  return [openCors, check, send];
}
