/**
 * The HTML pages the authorization server shows on its own origin (#55): the
 * consent page and the authorization error page.
 *
 * Both are static HTML with no script, served with PAGE_HEADERS: a strict CSP
 * (nothing loads; inline styles only; forms post only here; no <base>; no
 * framing), `Cache-Control: no-store`, no referrer and no sniffing. Every
 * value from a client (its name, redirect URI, error text) is HTML-escaped;
 * the name also has bidi, invisible and control characters removed
 * (displayClientName), so what the user reads is what the client registered.
 *
 * No Express or SDK import: when the authorization server moves to
 * oidc-provider (ADR-0002 D3), the interaction route renders the same pages.
 */

import { stripBidi, stripInvisible } from '../utils/sanitize.js';
import { displayClientName, redirectHostLabel } from './client-metadata.js';

/** The CSP of every page here (#55): nothing but inline styles; no framing. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Headers for every page here (Content-Type and Content-Length are set by whoever sends the body). */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': PAGE_CSP,
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
.btn{display:block;padding:.75rem 1rem;margin:.75rem 0;border:1px solid #ccc;border-radius:.5rem;text-decoration:none;color:#111}
.btn:hover{background:#f5f5f5}.muted{color:#666;font-size:.9rem}
.dest{font-size:1.1rem;padding:.75rem 1rem;border-left:4px solid #888;background:#f7f7f7}
.warn{padding:.75rem 1rem;border-left:4px solid #c60;background:#fff6ec}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>${STYLE}</style></head>
<body>
${body}
</body></html>`;
}

export interface ConsentPageInput {
  /** The client's registered name, as stored (shown through displayClientName). */
  clientName: unknown;
  clientId: string;
  /** The redirect URI this authorization returns to. */
  redirectUri: string;
  /** Whether that redirect URI is on this device (loopback). */
  loopback: boolean;
  /** The read-only, read-write and cancel links (absolute, on this server). */
  readOnlyLink: string;
  readWriteLink: string | undefined;
  cancelLink: string;
}

/**
 * The consent page. The redirect URI's host is shown prominently, the client
 * "calls itself" its name next to it, and a loopback one is labelled as
 * returning to this device.
 */
export function renderConsentPage(input: ConsentPageInput): string {
  const name = displayClientName(input.clientName);
  const host = redirectHostLabel(input.redirectUri) ?? input.redirectUri;
  const hostHtml = `<strong>${htmlEscape(host)}</strong>`;
  const who =
    name !== undefined
      ? `An application at ${hostHtml} that calls itself <strong>“${htmlEscape(name)}”</strong>`
      : `An application at ${hostHtml} (it gave no name)`;
  const loopback =
    input.loopback
      ? `<p class="warn">This address is on your own device. Continue only if you started this connection from an app on this computer.</p>\n`
      : '';
  return page(
    'Connect YNAB',
    `<h1>Connect your YNAB budget</h1>
<p>${who} is requesting access to your YNAB data. Choose the access level:</p>
<p class="dest">After you approve, you will be returned to ${hostHtml}</p>
${loopback}<p class="muted">Full address: <code>${htmlEscape(input.redirectUri)}</code>. Continue only if you started this connection and recognize that address.</p>
<a class="btn" href="${htmlEscape(input.readOnlyLink)}"><strong>Read-only</strong><br><span class="muted">View budgets, accounts, and transactions. No changes.</span></a>
${input.readWriteLink !== undefined ? `<a class="btn" href="${htmlEscape(input.readWriteLink)}"><strong>Read &amp; write</strong><br><span class="muted">View and modify (create/update/delete) your budget data.</span></a>` : ''}
<p class="muted">You'll be sent to YNAB to authorize. To end this access later, open your YNAB settings at app.ynab.com/settings, find Authorized Applications, and choose Revoke next to this server's app. It's listed under the name its owner gave it when registering it with YNAB.</p>
<p><a href="${htmlEscape(input.cancelLink)}">Cancel</a></p>`
  );
}

/** An OAuth error code as shown: the RFC 6749 charset only, else `server_error`. */
function safeErrorCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'server_error';
}

/** Free error text as shown: no bidi, invisible or control characters, at most 300 characters. */
function safeDescription(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = stripInvisible(stripBidi(text)).replace(/\p{Cc}/gu, ' ').trim();
  if (cleaned === '') return undefined;
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

export interface ErrorPageInput {
  error: unknown;
  errorDescription: unknown;
  /**
   * The authorization error response the client would have been redirected
   * to (its redirect URI with error, state and iss), offered as a link the
   * user may follow; undefined for no link.
   */
  returnUrl: string | undefined;
}

/** An authorization error page: the status, and the HTML. */
export function renderAuthorizationErrorPage(input: ErrorPageInput): { status: number; html: string } {
  const code = safeErrorCode(input.error);
  const description = safeDescription(input.errorDescription);
  const host = input.returnUrl !== undefined ? redirectHostLabel(input.returnUrl) : undefined;
  const back =
    input.returnUrl !== undefined && host !== undefined
      ? `<p>You can <a href="${htmlEscape(input.returnUrl)}">return to ${htmlEscape(host)}</a> to tell the application. Follow it only if you started this connection and recognize that address.</p>`
      : '<p>You can close this page.</p>';
  const html = page(
    'Authorization failed',
    `<h1>This authorization request can't be completed</h1>
<p>The application that sent you here made a request this server can't accept.</p>
<p class="muted">Error: <code>${htmlEscape(code)}</code>${description !== undefined ? ` (${htmlEscape(description)})` : ''}</p>
${back}`
  );
  return { status: code === 'server_error' ? 500 : 400, html };
}
