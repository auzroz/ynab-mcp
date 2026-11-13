/**
 * The part of the authorize guard (#55b) that is specific to server-legacy
 * 2.4.0's /authorize handler. **Replaced at #47-4** (ADR-0002): oidc-provider
 * sends its own error redirects, and the guard then pre-validates the
 * parameters the library would refuse instead of wrapping its response.
 * Nothing else imports this module.
 *
 * server-legacy answers every "phase-2" error (one found after the client and
 * its redirect URI were accepted) with a 302 to the client's redirect URI:
 *
 *   1. the request schema fails: `response_type` isn't `code`,
 *      `code_challenge` is missing, `code_challenge_method` isn't `S256`,
 *      `scope` or `state` isn't a string, or `resource` isn't a URL
 *      (`invalid_request`);
 *   2. `provider.authorize()` throws an OAuth error (`invalid_target` for a
 *      foreign `resource`);
 *   3. `provider.authorize()` throws anything else, such as a storage failure
 *      (`server_error`).
 *
 * Each of these is `res.redirect(302, url)`. captureRedirects() doesn't rely on
 * that: it wraps the three ways a response is committed (`writeHead`, `write`
 * and `end`), so a redirect sent with `res.writeHead(302, { Location })`, with
 * `setHeader('Location')` and `end()`, or through `flushHeaders()` is caught
 * as well. A captured redirect never reaches the client: its status, its
 * `Location` and every other header that could navigate or describe the body
 * are replaced by the page `render` returns, and the original body is dropped.
 */

import type { Response } from 'express';

/** What replaces a captured redirect. */
export interface CapturedRedirectReplacement {
  status: number;
  /** Headers of the page; Content-Length is set from `body`. */
  headers: Readonly<Record<string, string>>;
  body: string;
}

/** Response headers dropped from a captured redirect: anything that could navigate or describe the old body. */
const DROPPED_HEADERS = [
  'location',
  'refresh',
  'link',
  'content-length',
  'content-type',
  'content-encoding',
  'content-language',
  'content-disposition',
  'etag',
  'last-modified',
];

const isRedirect = (status: unknown): boolean => typeof status === 'number' && status >= 300 && status < 400;

/** The Location among headers passed to writeHead (an object or a flat [name, value, ...] array). */
function locationIn(headers: unknown): string | undefined {
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === 'location') return String(headers[i + 1]);
    }
    return undefined;
  }
  if (headers !== null && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (name.toLowerCase() === 'location') return Array.isArray(value) ? String(value[0]) : String(value);
    }
  }
  return undefined;
}

function headerValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

type Fn = (...args: unknown[]) => unknown;

/**
 * Make `res` refuse to send a redirect: the first 3xx it would commit is
 * replaced by `render(location)` instead, where `location` is the redirect
 * target it carried (undefined when it had none), unless `allow(location)`
 * says that target may be redirected to.
 */
export function captureRedirects(
  res: Response,
  render: (location: string | undefined) => CapturedRedirectReplacement,
  allow: (location: string | undefined) => boolean = () => false
): void {
  const target = res as unknown as Record<'writeHead' | 'write' | 'end', Fn>;
  const writeHead = target.writeHead.bind(res) as Fn;
  const write = target.write.bind(res) as Fn;
  const end = target.end.bind(res) as Fn;
  let replacement: CapturedRedirectReplacement | undefined;
  /** Set once the one redirect has been judged (replaced or allowed). */
  let decided = false;

  const takeOver = (location: string | undefined): void => {
    decided = true;
    if (allow(location)) return;
    replacement = render(location);
    for (const name of DROPPED_HEADERS) res.removeHeader(name);
    for (const [name, value] of Object.entries(replacement.headers)) res.setHeader(name, value);
    res.setHeader('Content-Length', Buffer.byteLength(replacement.body));
    res.statusCode = replacement.status;
  };
  /** Before the head is committed: take over a pending redirect set through statusCode and setHeader. */
  const checkPending = (): void => {
    if (!decided && !res.headersSent && isRedirect(res.statusCode)) {
      takeOver(headerValue(res.getHeader('location')));
    }
  };
  const callbackOf = (args: unknown[]): Fn | undefined => args.find((a): a is Fn => typeof a === 'function');

  target.writeHead = (statusCode: unknown, ...rest: unknown[]): unknown => {
    if (!decided && isRedirect(statusCode)) {
      const headers = typeof rest[0] === 'string' ? rest[1] : rest[0];
      takeOver(locationIn(headers) ?? headerValue(res.getHeader('location')));
    }
    // The page's head only: the redirect's own status message and headers are dropped.
    if (replacement !== undefined) return writeHead(replacement.status);
    return writeHead(statusCode, ...rest);
  };
  target.write = (...args: unknown[]): unknown => {
    checkPending();
    if (replacement !== undefined) {
      // The redirect's body is dropped; end() writes the page.
      const cb = callbackOf(args);
      if (cb) process.nextTick(cb);
      return true;
    }
    return write(...args);
  };
  target.end = (...args: unknown[]): unknown => {
    checkPending();
    if (replacement !== undefined) {
      const cb = callbackOf(args);
      return cb ? end(replacement.body, cb) : end(replacement.body);
    }
    return end(...args);
  };
}
