/**
 * The `LOG_LEVEL` gate. Startup sets the level once (src/entry.ts), from the
 * stdio or the HTTP config, which both parse it with {@link parseLogLevel}.
 *
 * Only `debug` and `info` lines are gated. Warnings and errors are written
 * whatever the level (their call sites use console.error / console.warn
 * directly), so `warn` and `error` both mean "no informational lines".
 * Security-relevant lines (the write policy, `[AUDIT]`, `[Rekey]`, every
 * `WARNING`) are never informational.
 *
 * Everything goes to stderr: on stdio, stdout is the JSON-RPC channel.
 * console.error is looked up at each call, so a test's spy sees it. Callers
 * pass text that is already safe to log (sanitized, no secrets).
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

let current: LogLevel = DEFAULT_LOG_LEVEL;

/**
 * `LOG_LEVEL` as both modes read it before validating: unset or empty is
 * `info`, anything else is lowercased (case-insensitive). Not trimmed, as no
 * other enum setting is.
 */
export function normalizeLogLevel(raw: string | undefined): string {
  return raw === undefined || raw === '' ? DEFAULT_LOG_LEVEL : raw.toLowerCase();
}

/** `LOG_LEVEL`, normalized and validated. Throws a value-free message. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const v = normalizeLogLevel(raw);
  if ((LOG_LEVELS as readonly string[]).includes(v)) return v as LogLevel;
  throw new Error(`Invalid value for LOG_LEVEL. Expected one of: ${LOG_LEVELS.join(', ')}.`);
}

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function enabled(level: LogLevel): boolean {
  return RANK[level] >= RANK[current];
}

/** Diagnostic detail, shown only at `LOG_LEVEL=debug`. */
export function logDebug(message: string): void {
  if (enabled('debug')) console.error(message);
}

/** Routine operational lines (startup, shutdown), hidden at `warn` and `error`. */
export function logInfo(message: string): void {
  if (enabled('info')) console.error(message);
}
