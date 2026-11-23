/**
 * The protected-resource metadata documents (RFC 9728), served by our own
 * `metadata` stage (ADR-0002 D8: "the PRM routes: unchanged"), as the SDK's
 * `metadataHandler` served them: any-origin CORS, `GET` (and the CORS
 * preflight) only, anything else 405. The authorization server's own
 * discovery documents are the library's (`as-library`).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { methodCheck } from './method-check.js';

/** The CORS answer of a metadata document: `*` on every response; a preflight is answered here (204). */
function openCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'OPTIONS') {
    next();
    return;
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  const requested = req.header('access-control-request-headers');
  if (requested !== undefined) {
    res.setHeader('Access-Control-Allow-Headers', requested);
    res.setHeader('Vary', 'Access-Control-Request-Headers');
  }
  res.setHeader('Content-Length', '0');
  res.status(204).end();
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
