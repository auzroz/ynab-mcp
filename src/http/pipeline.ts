/**
 * Named request pipelines for the HTTP transport.
 *
 * A route's pipeline is an ordered list of named stages, each one or more
 * Express handlers. Mounting a pipeline through mountStages() is the only way
 * the authorization server (src/auth/as-router.ts) adds middleware, so the
 * stage names it reports are exactly what runs, in that order. The names are
 * asserted per route by tests/unit/http-as-pipeline.test.ts (gate G21): a PR
 * that changes a route's stages changes that test on purpose.
 */

import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

/**
 * Max JSON request body. A maximal 100-transaction ynab_create_transactions payload
 * is on the order of 100KB, so 512kb leaves headroom without accepting multi-MB bodies.
 */
export const MAX_JSON_BODY = '512kb';

/** One named step of a route's pipeline. */
export interface Stage {
  readonly name: string;
  readonly handlers: readonly RequestHandler[];
}

/** A route (a path prefix, as app.use matches it) and the names of its stages, in order. */
export interface RoutePipeline {
  readonly route: string;
  readonly stages: readonly string[];
}

/**
 * Called as a request enters each stage, before the stage's handlers. Only
 * tests pass one, to record the order the stages actually ran in.
 */
export type StageObserver = (stage: string, req: Request) => void;

/** A named stage made of the given handlers. */
export function stage(name: string, ...handlers: RequestHandler[]): Stage {
  return { name, handlers };
}

/**
 * Mount the stages in order, on `path` (prefix match, like app.use) or on
 * every request when `path` is undefined. Returns the stage names. With an
 * observer, each stage is preceded by a pass-through handler that reports it;
 * without one, only the stages' own handlers are mounted.
 */
export function mountStages(
  router: Router,
  path: string | undefined,
  stages: readonly Stage[],
  observe?: StageObserver
): string[] {
  const handlers: RequestHandler[] = [];
  for (const s of stages) {
    if (observe) {
      const name = s.name;
      handlers.push((req: Request, _res: Response, next: NextFunction): void => {
        observe(name, req);
        next();
      });
    }
    handlers.push(...s.handlers);
  }
  if (handlers.length > 0) {
    if (path === undefined) router.use(...handlers);
    else router.use(path, ...handlers);
  }
  return stages.map((s) => s.name);
}
