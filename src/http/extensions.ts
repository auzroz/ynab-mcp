/**
 * Extension points of the HTTP transport, so a new route or background job
 * never needs an edit to src/http.ts.
 *
 *  - `routes` are mounted after Host/Origin validation, the authorization
 *    server and the global JSON parser, and before /mcp. They see the same
 *    Host check as every other route (except /health).
 *  - `jobs` start once storage is ready, when the server starts
 *    (startHttpServer, not buildHttpApp), and are stopped on its shutdown path
 *    (http.Server close). A job's timers should be unref()'d, and its stop()
 *    should finish promptly: it runs inside the shutdown deadline.
 *
 * The registries at the bottom are append-only, one line per module.
 */

import type { Router } from 'express';
import type { HttpConfig } from '../config/environment.js';
import type { Storage } from '../storage/types.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

/** What an extension gets to work with. */
export interface ExtensionContext {
  readonly config: HttpConfig;
  /** The server's storage; undefined in header mode, which has none. */
  readonly storage: Storage | undefined;
}

/** A module that adds routes. */
export interface RouteExtension {
  readonly name: string;
  mount(router: Router, ctx: ExtensionContext): void;
}

/** A started job. */
export interface JobHandle {
  stop(): void | Promise<void>;
}

/** A module that runs in the background. start() may return nothing when the job doesn't apply. */
export interface JobExtension {
  readonly name: string;
  start(ctx: ExtensionContext): JobHandle | undefined;
}

/** The jobs of one app: start() once, stop() any number of times. */
export interface JobRunner {
  start(): void;
  stop(): Promise<void>;
}

/**
 * A runner for `list`. start() starts each job in order; if one throws, the
 * ones already started are stopped and the error is rethrown, so the server
 * doesn't start with half its jobs. stop() stops every started job, logging
 * (never throwing) a failure so shutdown always completes.
 */
export function createJobRunner(list: readonly JobExtension[], ctx: ExtensionContext): JobRunner {
  let started = false;
  let handles: Array<{ name: string; handle: JobHandle }> = [];

  const stop = async (): Promise<void> => {
    const running = handles;
    handles = [];
    await Promise.all(
      running.map(async ({ name, handle }) => {
        try {
          await handle.stop();
        } catch (error) {
          console.error(`[Job] ${name} failed to stop:`, sanitizeErrorMessage(error));
        }
      })
    );
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      for (const job of list) {
        let handle: JobHandle | undefined;
        try {
          handle = job.start(ctx);
        } catch (error) {
          void stop();
          throw error;
        }
        if (handle) handles.push({ name: job.name, handle });
      }
    },
    stop,
  };
}

// ---- Registries (append-only, one line per module) -------------------------

/** Route modules, mounted in this order. */
export const routes: readonly RouteExtension[] = [];

/** Background jobs, started in this order. */
export const jobs: readonly JobExtension[] = [];
