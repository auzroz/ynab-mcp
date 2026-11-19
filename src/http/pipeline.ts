/**
 * Named request pipelines for the HTTP transport.
 *
 * A route's pipeline is an ordered list of named stages, each one or more
 * Express handlers. Mounting a pipeline through mountStages() is the only way
 * the authorization server (src/auth/as-router.ts) adds middleware, so the
 * stage names it reports are exactly what runs, in that order. The names are
 * asserted per route by tests/unit/http-as-pipeline.test.ts (gate G21): a PR
 * that changes a route's stages changes that test on purpose. /mcp's pipeline
 * (src/http.ts, ADR-0001) is mounted the same way, through mountRoute(), and
 * asserted by tests/unit/http-mcp-pipeline.test.ts.
 */

import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

/**
 * Max JSON request body. A maximal 100-transaction ynab_create_transactions payload
 * is on the order of 100KB, so 512kb leaves headroom without accepting multi-MB bodies.
 */
export const MAX_JSON_BODY = '512kb';

/** MAX_JSON_BODY in bytes, for the MCP SDK's own body bounds (ADR-0001 D12). */
export const MAX_JSON_BODY_BYTES = 512 * 1024;

/**
 * Max request body on the authorization server's routes (#55a), JSON or form.
 * A registration with five 512-character redirect URIs and every kept field
 * at its bound is under 4kb; a token or revocation request is far smaller.
 */
export const AS_MAX_BODY = '8kb';

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

/**
 * With an observer, the stage each mounted handler belongs to (the observer's
 * pass-through and the stage's own handlers). Tests walk the app's layer stack
 * with stageOfHandler() to check that nothing but these runs on an AS route
 * (G21). Filled only when an observer is passed, so production has no entries.
 */
const mountedStageHandlers = new WeakMap<RequestHandler, string>();

/** The stage `handler` was mounted for by mountStages() (with an observer), if any. */
export function stageOfHandler(handler: unknown): string | undefined {
  return typeof handler === 'function' ? mountedStageHandlers.get(handler as RequestHandler) : undefined;
}

/** A named stage made of the given handlers. */
export function stage(name: string, ...handlers: RequestHandler[]): Stage {
  return { name, handlers };
}

/**
 * Mount the stages in order, on `path` (prefix match, like app.use) or on
 * every request when `path` is undefined. Returns the stage names. With an
 * observer, each stage is preceded by a pass-through handler that reports it,
 * and every handler is recorded for stageOfHandler(); without one, only the
 * stages' own handlers are mounted.
 */
export function mountStages(
  router: Router,
  path: string | undefined,
  stages: readonly Stage[],
  observe?: StageObserver
): string[] {
  const handlers = stageHandlers(stages, observe);
  if (handlers.length > 0) {
    if (path === undefined) router.use(...handlers);
    else router.use(path, ...handlers);
  }
  return stages.map((s) => s.name);
}

/**
 * Like mountStages, but for exactly `path` and every HTTP method (one route,
 * `route(path).all`), not the prefix: /mcp's pipeline, so /mcp/anything is
 * not served by it. Returns the stage names.
 */
export function mountRoute(router: Router, path: string, stages: readonly Stage[], observe?: StageObserver): string[] {
  const handlers = stageHandlers(stages, observe);
  if (handlers.length > 0) router.route(path).all(...handlers);
  return stages.map((s) => s.name);
}

/** The stages' handlers in order, each preceded by its observer pass-through when there is one. */
function stageHandlers(stages: readonly Stage[], observe: StageObserver | undefined): RequestHandler[] {
  const handlers: RequestHandler[] = [];
  for (const s of stages) {
    if (observe) {
      const name = s.name;
      const report = (req: Request, _res: Response, next: NextFunction): void => {
        observe(name, req);
        next();
      };
      mountedStageHandlers.set(report, name);
      for (const h of s.handlers) mountedStageHandlers.set(h, name);
      handlers.push(report);
    }
    handlers.push(...s.handlers);
  }
  return handlers;
}
