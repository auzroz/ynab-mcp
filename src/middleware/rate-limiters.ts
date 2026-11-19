/**
 * The keyed limiters of the authorization server's routes (#59), as handler
 * lists a pipeline stage wraps. Self-contained: a stage that uses one needs
 * nothing from the rest of the AS, so it stays ahead of whatever answers the
 * route (the SDK's handlers today).
 *
 * Every express-rate-limit instance is built by createLimiter(), the one place
 * a shared store (#67b) is swapped in: each limiter asks the optional
 * `LimiterStoreFactory` for a store under its own name, and gets the library's
 * in-memory store when there is none.
 *
 * A client-keyed route gets two budgets in one stage, the IP-only ceiling
 * first (so one address cannot create unbounded client-keyed entries), then
 * the (client_id, IP) budget. client_id is public and free to invent, so
 * without the ceiling one address could mint a fresh bucket per request.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit, type Options, type RateLimitRequestHandler, type Store } from 'express-rate-limit';
import { clientKey, clientIp, redirectHostKeys, type ClientKeyOptions } from './rate-limit-key.js';

/** The IP-only ceiling is this many times the (client_id, IP) limit. */
export const CEILING_FACTOR = 10;

/**
 * Makes a store for the limiter called `name` (unique per limiter instance),
 * or returns undefined to keep the in-memory default. A shared store (#67b)
 * implements express-rate-limit's `Store` and is returned here, namespaced by
 * `name`.
 */
export type LimiterStoreFactory = (name: string) => Store | undefined;

/** What a limiter is built from; everything else is fixed by createLimiter(). */
export type LimiterConfig = Partial<Options> & Pick<Options, 'windowMs' | 'limit'>;

/** The one constructor of rate limiters in the authorization server. */
export function createLimiter(
  name: string,
  config: LimiterConfig,
  storeFactory?: LimiterStoreFactory
): RateLimitRequestHandler {
  const store = storeFactory?.(name);
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    // Our own keys are already collapsed to /64; the library's IPv6 check
    // cannot see through a custom generator.
    validate: { keyGeneratorIpFallback: false },
    ...config,
    ...(store ? { store } : {}),
  });
}

export interface KeyedLimiterOptions {
  /** Names this limiter's store(s); unique across the server. */
  readonly name: string;
  readonly windowMs: number;
  /** Requests per key per window. */
  readonly limit: number;
  /** The 429 body. */
  readonly message: unknown;
  readonly key: ClientKeyOptions;
  /**
   * Key by (client_id, IP) with this extractor (undefined result: IP only).
   * Absent: key by IP alone.
   */
  readonly clientId?: ((req: Request) => string | undefined) | undefined;
  /** With `clientId`: also apply the IP-only ceiling (default true). */
  readonly ceiling?: boolean;
  /** Which requests are not counted (default: preflights only). */
  readonly skip?: (req: Request) => boolean;
  /**
   * Send `Access-Control-Allow-Origin: *` before answering, as the SDK's own
   * handlers do, so a browser client can read the 429 this limiter sends.
   */
  readonly cors?: boolean;
  readonly store?: LimiterStoreFactory | undefined;
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
  const common = {
    windowMs: options.windowMs,
    message: options.message,
    skip: options.skip ?? isPreflight,
  } as const;
  const handlers: RequestHandler[] = [];
  if (options.cors) handlers.push(corsHeader());
  const { clientId } = options;
  if (clientId && options.ceiling !== false) {
    // First: a request over the address's ceiling never reaches the
    // client-keyed store. A request the client-keyed budget then refuses has
    // still counted here, so clients behind one egress address share the
    // ceiling.
    handlers.push(
      createLimiter(
        `${options.name}:ip`,
        { ...common, limit: options.limit * CEILING_FACTOR, keyGenerator: (req) => clientKey(req, options.key) },
        options.store
      )
    );
  }
  handlers.push(
    createLimiter(
      clientId ? `${options.name}:client` : options.name,
      {
        ...common,
        limit: options.limit,
        keyGenerator: (req) => clientKey(req, options.key, clientId ? { clientId: clientId(req) } : {}),
      },
      options.store
    )
  );
  return handlers;
}

export interface RegisterLimiterOptions {
  readonly windowMs: number;
  readonly perIp: number;
  readonly perHost: number;
  /** Redirect hosts counted per (host, IP) instead of per host (see redirectHostKeys). */
  readonly verifiedHosts?: ReadonlySet<string> | undefined;
  readonly message: unknown;
  /** The 400 for a registration that names too many redirect URIs. */
  readonly tooManyRedirects: unknown;
  readonly key: ClientKeyOptions;
  readonly store?: LimiterStoreFactory | undefined;
}

/**
 * /register, before the body is read: a per-IP limit (higher than the SDK's
 * 20/h, so hosted clients behind one address range are not locked out by each
 * other), with the CORS header the SDK would have added.
 */
export function registerIpLimiter(options: RegisterLimiterOptions): RequestHandler[] {
  return keyedLimiter({
    name: 'register:ip',
    windowMs: options.windowMs,
    limit: options.perIp,
    message: options.message,
    key: options.key,
    cors: true,
    store: options.store,
  });
}

/**
 * /register, after the body is parsed and validated: a budget per
 * redirect-URI host (see redirectHostKeys; verified and loopback hosts per
 * host and IP), counted once for each distinct host the registration names.
 * The registration is refused as soon as any of them is spent. A list of more
 * than MAX_REDIRECT_URIS entries is refused with 400.
 */
export function registerHostLimiter(options: RegisterLimiterOptions): RequestHandler {
  const limiter = createLimiter(
    'register:host',
    {
      windowMs: options.windowMs,
      limit: options.perHost,
      skip: isPreflight,
      keyGenerator: (_req, res) => String((res.locals as { rateLimitKey?: string }).rateLimitKey),
      validate: false,
      handler: (_req, res) => {
        res.status(429).json(options.message);
        (res.locals as { rateLimitDone?: (ok: boolean) => void }).rateLimitDone?.(false);
      },
    },
    options.store
  );

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
      const keys = redirectHostKeys(req.body, clientIp(req, options.key), options.verifiedHosts);
      if (!keys) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(400).json(options.tooManyRedirects);
        return;
      }
      for (const key of keys) {
        if (!(await count(req, res, key))) return; // 429 sent
      }
      next();
    })().catch(next);
  };
}
