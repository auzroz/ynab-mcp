/**
 * Parsers for environment variables, shared by the stdio config and the HTTP
 * loaders. Every message is value-free: a secret pasted into the wrong
 * variable must not reach the startup log.
 */

/** The environment a loader reads (process.env, or a plain object in tests). */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Parse a boolean environment variable with strict validation.
 *
 * Accepts: 'true', '1', 'yes' => true
 *          'false', '0', 'no' => false
 *          undefined/empty => defaultValue
 *
 * Throws on unrecognized values to prevent security footguns
 * (e.g., YNAB_READ_ONLY=ture typo accidentally enabling writes).
 */
export function parseBoolean(value: string | undefined, defaultValue: boolean, varName?: string): boolean {
  if (value === undefined || value === '') return defaultValue;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;

  const nameHint = varName ? ` for ${varName}` : '';
  throw new Error(
    `Invalid boolean value${nameHint}. ` +
    `Expected: true, false, 1, 0, yes, or no.`
  );
}

/**
 * Parse an integer environment variable with strict validation.
 *
 * Rejects partial parses like "10ms" that parseInt would accept as 10.
 * Only accepts strings containing only digits.
 */
export function parseInteger(value: string | undefined, defaultValue: number, varName?: string): number {
  if (value === undefined || value === '') return defaultValue;

  // Strict check: only digits allowed (no partial parses like "10ms" -> 10)
  if (!/^\d+$/.test(value)) {
    const nameHint = varName ? ` for ${varName}` : '';
    throw new Error(
      `Invalid integer value${nameHint}. ` +
      `Expected a positive integer (digits only).`
    );
  }

  // Digits alone still allow values past 2^53 (or Infinity for very long
  // strings), which would not be the limit the operator wrote.
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    const nameHint = varName ? ` for ${varName}` : '';
    throw new Error(`Invalid integer value${nameHint}. Expected an integer no larger than ${Number.MAX_SAFE_INTEGER}.`);
  }
  return n;
}

/**
 * Parse an integer that must lie in [min, max]. The default is the code's own
 * value and is not range checked; an explicit value is.
 */
export function parseBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  varName: string,
  min: number,
  max: number
): number {
  const n = parseInteger(value, defaultValue, varName);
  if (value === undefined || value === '') return n;
  if (n < min || n > max) {
    throw new Error(`Invalid value for ${varName}. Expected an integer between ${min} and ${max}.`);
  }
  return n;
}

/** Split a comma/space-separated env list into a trimmed string array (or undefined). */
export function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Parse and validate an absolute http(s) URL used as a public identifier.
 * https is required except for loopback hosts; fragments are rejected.
 */
export function parseAbsoluteUrl(value: string, varName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${varName}: must be an absolute URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid ${varName}: scheme must be https (http is allowed only for localhost).`);
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error(`Invalid ${varName}: https is required (http is allowed only for localhost, 127.0.0.1 or [::1]).`);
  }
  if (url.hash !== '' || value.includes('#')) {
    throw new Error(`Invalid ${varName}: must not contain a fragment.`);
  }
  return url;
}

/**
 * Collects every configuration problem so the operator sees them all in one
 * startup message instead of fixing them one restart at a time.
 *
 * A loader wraps each parse in `capture(varName, parse, fallback)`: a throw is
 * recorded under the variable's name and the fallback is returned, so the
 * remaining settings (and the cross-setting checks) still run.
 */
export class ConfigProblems {
  private readonly items: Array<{ varName: string; message: string }> = [];

  /** Record a problem with `varName`. `message` must not contain a value. */
  add(varName: string, message: string): void {
    this.items.push({ varName, message });
  }

  /** Run `parse`; on a throw, record the (value-free) message and return `fallback`. */
  capture<T>(varName: string, parse: () => T, fallback: T): T {
    try {
      return parse();
    } catch (error) {
      this.add(varName, error instanceof Error ? error.message : `Invalid ${varName}.`);
      return fallback;
    }
  }

  /** Whether a problem was recorded for `varName` (a cross-check skips rules built on a bad value). */
  failed(varName: string): boolean {
    return this.items.some((p) => p.varName === varName);
  }

  get count(): number {
    return this.items.length;
  }

  /** Throw one error listing every problem, or return when there is none. */
  throwIfAny(): void {
    if (this.items.length === 0) return;
    const n = this.items.length;
    const lines = this.items.map((p) => `  - ${p.message}`).join('\n');
    throw new Error(`Invalid configuration (${n} problem${n === 1 ? '' : 's'}):\n${lines}`);
  }
}
