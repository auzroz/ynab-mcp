/**
 * The shape of an HTTP config loader. Each file in this folder owns one topic:
 * it reads its own environment variables, records problems instead of
 * throwing, and returns its slice of HttpConfig. `loadHttpConfig()` (index.ts)
 * composes them.
 */

import type { ConfigProblems, Env } from '../parse.js';

export interface LoaderContext {
  readonly env: Env;
  readonly problems: ConfigProblems;
}

export type HttpLoader<Slice> = (ctx: LoaderContext) => Slice;
