/**
 * The keyed limiters of the authorization server's routes (#59), as handler
 * lists a pipeline stage wraps. Self-contained: a stage that uses one needs
 * nothing from the rest of the AS, so it stays ahead of whatever answers the
 * route (the SDK's handlers today).
 *
 * Every unauthenticated route gets two budgets in one stage:
 *  - the (client_id, IP) budget the route is documented with, and
 *  - an IP-only ceiling of CEILING_FACTOR times that. client_id is public and
 *    free to invent, so without the ceiling one address could mint a fresh
 *    bucket per request by rotating it.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  clientKey,
  clientIp,
  redirectHostKeys,
  requestClientId,
  type ClientKeyOptions,
} from './rate-limit-key.js';

/** The IP-only ceiling is this many times the (client_id, IP) limit. */
export const CEILING_FACTOR = 10;

export interface KeyedLimiterOptions {
  readonly windowMs: number;
  /** Requests per key per window. */
  readonly limit: number;
  /** The 429 body. */
  readonly message: unknown;
  readonly key: ClientKeyOptions;
  /** Key by (client_id, IP) and add the IP-only ceiling. False: IP only, no ceiling. */
  readonly byClient: boolean;
  /** Which requests are not counted (default: preflights only). */
  readonly skip?: (req: Request) => boolean;
  /**
   * Send `Access-Control-Allow-Origin: *` before answering, as the SDK's own
   * handlers do, so a browser client can read the 429 this limiter sends.
   */
  readonly cors?: boolean;
}

const isPreflight = (req: Request): boolean => req.method === 'OPTIONS';

function corsHeader(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'OPTIONS') res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  };
}

/** The handlers of one keyed route limiter, in order. */
export function keyedLimiter(options: KeyedLimiterOptions): RequestHandler[] {
  const skip = options.skip ?? isPreflight;
  const common = {
    windowMs: options.windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    message: options.message,
    skip,
  } as const;
  const handlers: RequestHandler[] = [];
  if (options.cors) handlers.push(corsHeader());
  handlers.push(
    rateLimit({
      ...common,
      limit: options.limit,
      keyGenerator: (req) =>
        clientKey(req, options.key, options.byClient ? { clientId: requestClientId(req) } : {}),
      // Our own key is already collapsed to /64; the library's IPv6 check
      // cannot see through a custom generator.
      validate: { keyGeneratorIpFallback: false },
    })
  );
  if (options.byClient) {
    handlers.push(
      rateLimit({
        ...common,
        // Headers come from the tighter limiter above.
        standardHeaders: false,
        limit: options.limit * CEILING_FACTOR,
        keyGenerator: (req) => clientKey(req, options.key),
        validate: { keyGeneratorIpFallback: false },
      })
    );
  }
  return handlers;
}

export interface RegisterLimiterOptions {
  readonly windowMs: number;
  readonly perIp: number;
  readonly perHost: number;
  readonly message: unknown;
  readonly key: ClientKeyOptions;
}

/**
 * /register, before the body is read: a per-IP limit (higher than the SDK's
 * 20/h, so hosted clients behind one address range are not locked out by each
 * other), with the CORS header the SDK would have added.
 */
export function registerIpLimiter(options: RegisterLimiterOptions): RequestHandler[] {
  return keyedLimiter({
    windowMs: options.windowMs,
    limit: options.perIp,
    message: options.message,
    key: options.key,
    byClient: false,
    cors: true,
  });
}

/**
 * /register, after the body is parsed: a budget per redirect-URI host (see
 * redirectHostKeys), counted once for each distinct host the registration
 * names. The registration is refused as soon as any of them is spent.
 */
export function registerHostLimiter(options: RegisterLimiterOptions): RequestHandler {
  const limiter = rateLimit({
    windowMs: options.windowMs,
    limit: options.perHost,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isPreflight,
    keyGenerator: (_req, res) => String((res.locals as { rateLimitKey?: string }).rateLimitKey),
    validate: false,
    handler: (_req, res) => {
      res.status(429).json(options.message);
      (res.locals as { rateLimitDone?: (ok: boolean) => void }).rateLimitDone?.(false);
    },
  });

  const count = (req: Request, res: Response, key: string): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      const locals = res.locals as { rateLimitKey?: string; rateLimitDone?: (ok: boolean) => void };
      locals.rateLimitKey = key;
      locals.rateLimitDone = resolve;
      limiter(req, res, (err?: unknown) => (err ? reject(err) : resolve(true)));
    });

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPreflight(req)) {
      next();
      return;
    }
    void (async () => {
      const keys = redirectHostKeys(req.body, clientIp(req, options.key));
      for (const key of keys) {
        if (!(await count(req, res, key))) return; // 429 sent
      }
      next();
    })().catch(next);
  };
}
