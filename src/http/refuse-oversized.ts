/**
 * Early refusal of an oversized request body, without a connection reset.
 *
 * A 413 sent while the client is still uploading, followed by a close on the
 * unread body, reaches a well-behaved client as EPIPE/ECONNRESET before it
 * can read the status (#137). So after the 413 the rest of the body is read
 * and discarded, up to a byte bound and a time bound; past either the socket
 * is destroyed. The body is never passed to a handler.
 */

import type { Request, RequestHandler, Response } from 'express';
import { MAX_JSON_BODY_BYTES } from './pipeline.js';

/** Most bytes read and discarded after a refusal; a larger body is cut off. */
export const MAX_DRAIN_BYTES = 1024 * 1024;

/** Longest a refused upload may keep its connection open. */
export const MAX_DRAIN_MS = 3000;

/**
 * Discard the rest of the request body, then let the connection go. Bounded
 * by min(declared Content-Length, bytes) and `ms`; past either, the socket is
 * destroyed.
 */
export function drainRequest(req: Request, bytes = MAX_DRAIN_BYTES, ms = MAX_DRAIN_MS): void {
  if (req.readableEnded || req.destroyed) return;
  const declared = Number(req.headers['content-length']);
  const bound = Number.isFinite(declared) && declared >= 0 ? Math.min(declared, bytes) : bytes;
  let seen = 0;
  const cleanup = (): void => {
    clearTimeout(timer);
    req.off('data', onData);
    req.off('end', cleanup);
    req.off('close', cleanup);
    req.off('error', cleanup);
  };
  const cut = (): void => {
    cleanup();
    req.socket.destroy();
  };
  const timer = setTimeout(cut, ms);
  timer.unref();
  const onData = (chunk: Buffer): void => {
    seen += chunk.length;
    // Past the bound with the body still coming: cut it off.
    if (seen > bound) cut();
  };
  req.on('data', onData);
  req.on('end', cleanup);
  req.on('close', cleanup);
  req.on('error', cleanup);
  req.resume();
}

/**
 * Refuse a request whose declared Content-Length is over `limit` with 413
 * before any later stage (or the SDK, which refuses it without reading any of
 * it) sees the body, then drain it. `respond` writes the 413.
 */
export function refuseOversizedBody(
  respond: (res: Response) => void,
  limit: number = MAX_JSON_BODY_BYTES
): RequestHandler {
  return (req, res, next) => {
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= limit) {
      next();
      return;
    }
    respond(res);
    drainRequest(req);
  };
}
