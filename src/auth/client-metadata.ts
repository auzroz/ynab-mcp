/**
 * Client metadata rules (#55): what a dynamic client registration may hold,
 * how a stored client is checked again at /authorize, how a redirect URI is
 * classified and trusted, and how a client's name is shown.
 *
 * Pure functions only, with no Express and no SDK import: the dcr-validator,
 * authorize-validation and authorize-guard stages and the consent page use
 * them, and they stay unchanged when the authorization server moves to
 * oidc-provider (ADR-0002, #47-4).
 *
 * A registration (RFC 7591) keeps only the fields this server uses
 * (CLIENT_METADATA_FIELDS) and drops every other one, as RFC 7591 section 2
 * asks: `jwks`, `jwks_uri`, `contacts`, `software_statement`, `logo_uri`,
 * `client_uri`, `tos_uri` and `policy_uri` are never stored or shown. The
 * fields it keeps are bounded:
 *
 *   - `redirect_uris`: 1 to MAX_REDIRECT_URIS, each at most
 *     MAX_REDIRECT_URI_LENGTH characters, with no userinfo and no fragment;
 *     `https://`, or `http://` only for localhost, 127.0.0.1 and [::1], or a
 *     private-use scheme from MCP_DCR_PRIVATE_USE_SCHEMES (RFC 8252 7.1);
 *   - `client_name`: NFKC-normalized, 1 to MAX_CLIENT_NAME_LENGTH printable
 *     characters (no control, format, bidi, zero-width or private-use
 *     characters);
 *   - the other kept fields: short strings and short lists of them.
 *
 * Errors say which rule failed and where, never the value sent.
 */

import { z } from 'zod';
import { LOOPBACK_HOSTNAMES } from '../config/parse.js';
import { MAX_REDIRECT_URI_LENGTH, isReservedScheme } from '../config/http/dcr.js';
import { hasInvisible, stripBidi, stripInvisible } from '../utils/sanitize.js';

export { MAX_REDIRECT_URI_LENGTH };

/** At most this many redirect URIs per client. */
export const MAX_REDIRECT_URIS = 5;

/** The longest `client_name`, in code points, after NFKC normalization. */
export const MAX_CLIENT_NAME_LENGTH = 100;

/** The registration fields kept; any other field is dropped (RFC 7591 section 2). */
export const CLIENT_METADATA_FIELDS = [
  'redirect_uris',
  'client_name',
  'token_endpoint_auth_method',
  'grant_types',
  'response_types',
  'scope',
  'application_type',
  'software_id',
  'software_version',
] as const;

/** The redirect-URI and client-name policy a registration is checked against. */
export interface ClientMetadataPolicy {
  /** Private-use schemes allowed in redirect URIs: lowercase, no colon. */
  readonly privateUseSchemes: readonly string[];
}

/** How errors and the consent page treat a redirect URI. */
export interface RedirectPolicy extends ClientMetadataPolicy {
  /** Redirect URIs whose clients are verified, as URL `href`s. */
  readonly verifiedRedirectUris: ReadonlySet<string>;
  /** Whether loopback redirect URIs receive error redirects. */
  readonly trustLoopbackRedirects: boolean;
}

/** Build a RedirectPolicy from the loaded settings (src/config/http/dcr.ts). */
export function redirectPolicyFrom(settings: {
  verifiedRedirectUris: readonly string[];
  privateUseSchemes: readonly string[];
  trustLoopbackRedirects: boolean;
}): RedirectPolicy {
  return {
    verifiedRedirectUris: new Set(settings.verifiedRedirectUris),
    privateUseSchemes: settings.privateUseSchemes,
    trustLoopbackRedirects: settings.trustLoopbackRedirects,
  };
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

/**
 * What a redirect URI is:
 *   - `https`: an https URL with a host (loopback hosts included);
 *   - `loopback-http`: http to localhost, 127.0.0.1 or [::1];
 *   - `private-use`: a scheme from the allow-list;
 *   - `plain-http`: http to any other host (never accepted);
 *   - `invalid`: anything else.
 */
export type RedirectUriKind = 'https' | 'loopback-http' | 'private-use' | 'plain-http' | 'invalid';

export interface RedirectUriCheck {
  readonly kind: RedirectUriKind;
  /** Why the URI is refused; undefined when it is acceptable. Never contains the URI. */
  readonly problem: string | undefined;
}

/** Parse an absolute URL, or undefined. */
function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** Classify a redirect URI and say what, if anything, is wrong with it. */
export function checkRedirectUri(raw: unknown, policy: ClientMetadataPolicy): RedirectUriCheck {
  const refuse = (problem: string, kind: RedirectUriKind = 'invalid'): RedirectUriCheck => ({ kind, problem });
  if (typeof raw !== 'string' || raw === '') return refuse('must be a non-empty string');
  if (raw.length > MAX_REDIRECT_URI_LENGTH) return refuse(`must be at most ${MAX_REDIRECT_URI_LENGTH} characters`);
  const url = parseUrl(raw);
  if (url === undefined) return refuse('must be an absolute URI');
  if (raw.includes('#')) return refuse('must not contain a fragment');
  if (url.username !== '' || url.password !== '') return refuse('must not contain userinfo');
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https') {
    if (url.hostname === '') return refuse('must name a host');
    return { kind: 'https', problem: undefined };
  }
  if (scheme === 'http') {
    if (LOOPBACK_HOSTNAMES.has(url.hostname)) return { kind: 'loopback-http', problem: undefined };
    return refuse('http is allowed only for localhost, 127.0.0.1 and [::1]; use https', 'plain-http');
  }
  if (isReservedScheme(scheme)) return refuse('this scheme is not allowed');
  if (policy.privateUseSchemes.includes(scheme)) return { kind: 'private-use', problem: undefined };
  return refuse('this private-use scheme is not on the server allow-list (MCP_DCR_PRIVATE_USE_SCHEMES)');
}

/** Whether a redirect URI points at this device: http or https to localhost, 127.0.0.1 or [::1]. */
export function isLoopbackRedirectUri(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== undefined && (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Whether a redirect URI is plain http to a host other than loopback. */
export function isPlainHttpRedirectUri(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== undefined && url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * Whether a requested redirect URI matches a registered one (RFC 6749
 * section 3.1.2.3, RFC 9700 section 2.1): the exact string, or, for an
 * `http://` loopback redirect URI only, the same URI on another port (RFC 8252
 * section 7.3, for a native app's ephemeral port). Nothing else may differ:
 * scheme, userinfo, host, path and query must be equal, and neither may carry
 * a fragment. Stricter than server-legacy's matcher, which also relaxes the
 * port for https loopback URIs and ignores userinfo and fragments; the
 * authorize-validation stage refuses what this refuses before the handler
 * runs.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  if (requested.includes('#') || registered.includes('#')) return false;
  const req = parseUrl(requested);
  const reg = parseUrl(registered);
  if (req === undefined || reg === undefined) return false;
  if (req.protocol !== 'http:' || reg.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(reg.hostname)) return false;
  return (
    req.username === reg.username &&
    req.password === reg.password &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

/**
 * How far a redirect URI is trusted:
 *   - `verified`: on MCP_VERIFIED_REDIRECT_URIS;
 *   - `loopback`: on this device;
 *   - `unverified`: anything else.
 */
export type RedirectTrust = 'verified' | 'loopback' | 'unverified';

export function redirectTrust(redirectUri: string, policy: RedirectPolicy): RedirectTrust {
  const url = parseUrl(redirectUri);
  if (url !== undefined && policy.verifiedRedirectUris.has(url.href)) return 'verified';
  if (isLoopbackRedirectUri(redirectUri)) return 'loopback';
  return 'unverified';
}

/**
 * The verified-client predicate (55b): whether an authorization error may be
 * redirected to this redirect URI (RFC 6749 section 4.1.2.1). Otherwise it is
 * shown on this server's own page.
 */
export function errorsMayRedirect(redirectUri: string, policy: RedirectPolicy): boolean {
  const trust = redirectTrust(redirectUri, policy);
  return trust === 'verified' || (trust === 'loopback' && policy.trustLoopbackRedirects);
}

/**
 * The part of a redirect URI a person can check: the host (with any port) for
 * http(s), the scheme for a private-use URI. Undefined when it doesn't parse.
 */
export function redirectHostLabel(redirectUri: string): string | undefined {
  const url = parseUrl(redirectUri);
  if (url === undefined) return undefined;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '') return url.host;
  return url.host !== '' ? `${url.protocol}//${url.host}` : url.protocol;
}

// ---------------------------------------------------------------------------
// Client names
// ---------------------------------------------------------------------------

/** Characters a client name must not contain: control, line/paragraph separators, private use, surrogates. */
const NAME_FORBIDDEN = /[\p{Cc}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;

/** NFKC-normalize and check a client name; returns it, or a problem. */
export function checkClientName(raw: unknown): { name: string; problem?: undefined } | { name?: undefined; problem: string } {
  if (typeof raw !== 'string') return { problem: 'must be a string' };
  // A lone surrogate is not valid Unicode (NAME_FORBIDDEN's \p{Cs} refuses it below).
  const name = raw.normalize('NFKC').trim();
  if (name === '') return { problem: 'must not be empty' };
  if ([...name].length > MAX_CLIENT_NAME_LENGTH) return { problem: `must be at most ${MAX_CLIENT_NAME_LENGTH} characters` };
  if (NAME_FORBIDDEN.test(name) || hasInvisible(name)) {
    return { problem: 'must contain only printable characters (no control, bidi or zero-width characters)' };
  }
  return { name };
}

/**
 * A stored client name as the consent page shows it: NFKC-normalized, with
 * bidi controls, invisible and control characters removed, whitespace
 * collapsed, and cut to MAX_CLIENT_NAME_LENGTH. Undefined when nothing is
 * left. Applies to clients registered before these rules too. The caller
 * still HTML-escapes it.
 */
export function displayClientName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = stripInvisible(stripBidi(raw.replace(/\p{Cs}/gu, '').normalize('NFKC')))
    .replace(/[\p{Cc}\p{Co}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '') return undefined;
  const chars = [...cleaned];
  return chars.length > MAX_CLIENT_NAME_LENGTH ? `${chars.slice(0, MAX_CLIENT_NAME_LENGTH).join('')}…` : cleaned;
}

// ---------------------------------------------------------------------------
// Registration (RFC 7591)
// ---------------------------------------------------------------------------

/** A short token-like string: a grant type, response type, auth method or application type. */
const shortToken = (max: number) =>
  z.string().min(1).max(max).regex(/^[\x21-\x7E]+$/, { message: 'must be printable ASCII without spaces' });

/** The kept fields' types and bounds. Unknown fields are stripped (zod's default). */
const ClientMetadataShape = z.object({
  redirect_uris: z.array(z.unknown()).min(1, { message: 'at least one is required' }).max(MAX_REDIRECT_URIS, {
    message: `at most ${MAX_REDIRECT_URIS} are allowed`,
  }),
  client_name: z.unknown().optional(),
  token_endpoint_auth_method: shortToken(64).optional(),
  grant_types: z.array(shortToken(128)).max(5).optional(),
  response_types: z.array(shortToken(64)).max(5).optional(),
  scope: z.string().max(256).optional(),
  application_type: shortToken(16).optional(),
  software_id: z.string().max(128).optional(),
  software_version: z.string().max(64).optional(),
});

/** The metadata a valid registration keeps. */
export type ClientMetadata = {
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  application_type?: string;
  software_id?: string;
  software_version?: string;
};

/** A refused registration: the RFC 7591 section 3.2.2 error code and a value-free description. */
export interface ClientMetadataError {
  readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata';
  readonly error_description: string;
}

export type ClientMetadataResult =
  | { ok: true; metadata: ClientMetadata }
  | { ok: false; error: ClientMetadataError };

const metadataError = (description: string): ClientMetadataResult => ({
  ok: false,
  error: { error: 'invalid_client_metadata', error_description: description },
});
const redirectError = (description: string): ClientMetadataResult => ({
  ok: false,
  error: { error: 'invalid_redirect_uri', error_description: description },
});

/** "field" or "field[1]" for an issue path. */
function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');
}

/**
 * Validate a registration request body. On success, `metadata` holds only the
 * kept fields, with `client_name` normalized; when every redirect URI is
 * loopback or private-use, `application_type` is `native` (RFC 8252; it keeps
 * the loopback port relaxation under oidc-provider, ADR-0002 D8).
 */
export function validateClientMetadata(body: unknown, policy: ClientMetadataPolicy): ClientMetadataResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return metadataError('The registration must be a JSON object');
  }
  const parsed = ClientMetadataShape.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? fieldPath(issue.path) : '';
    const message = issue?.message ?? 'is invalid';
    if (issue?.path[0] === 'redirect_uris') {
      return redirectError(`redirect_uris: ${'redirect_uris' in body ? message : 'is required'}`);
    }
    return metadataError(`${where || 'metadata'}: ${message}`);
  }
  const shape = parsed.data;

  const kinds: RedirectUriKind[] = [];
  for (const [i, uri] of shape.redirect_uris.entries()) {
    const check = checkRedirectUri(uri, policy);
    if (check.problem !== undefined) return redirectError(`redirect_uris[${i}]: ${check.problem}`);
    kinds.push(check.kind);
  }
  const redirectUris = shape.redirect_uris as string[];
  if (new Set(redirectUris).size !== redirectUris.length) {
    return redirectError('redirect_uris: must not repeat a URI');
  }

  const metadata: ClientMetadata = { ...shape, redirect_uris: redirectUris } as ClientMetadata;
  if (shape.client_name !== undefined) {
    const name = checkClientName(shape.client_name);
    if (name.problem !== undefined) return metadataError(`client_name: ${name.problem}`);
    metadata.client_name = name.name;
  } else {
    delete metadata.client_name;
  }
  if (kinds.every((k) => k === 'loopback-http' || k === 'private-use')) metadata.application_type = 'native';
  return { ok: true, metadata };
}

/**
 * The rules a stored client fails, by name only (no values), for a client
 * registered before these rules (grandfathered, #55). `plainHttp` is the one
 * rule that is enforced on stored clients: a client with a non-loopback
 * `http://` redirect URI is refused at /authorize. The other failures are
 * only logged.
 */
export function checkStoredClient(
  client: Record<string, unknown>,
  policy: ClientMetadataPolicy
): { plainHttp: boolean; failures: string[] } {
  const failures: string[] = [];
  const uris = Array.isArray(client['redirect_uris']) ? (client['redirect_uris'] as unknown[]) : [];
  const plainHttp = uris.some((u) => typeof u === 'string' && isPlainHttpRedirectUri(u));
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS) failures.push('redirect_uris count');
  uris.forEach((uri, i) => {
    const check = checkRedirectUri(uri, policy);
    if (check.problem !== undefined) failures.push(`redirect_uris[${i}] ${check.kind}`);
  });
  if (client['client_name'] !== undefined && checkClientName(client['client_name']).problem !== undefined) {
    failures.push('client_name');
  }
  const known = new Set<string>([
    ...CLIENT_METADATA_FIELDS,
    // Set by the server at registration, not sent by the client.
    'client_id',
    'client_id_issued_at',
    'client_secret',
    'client_secret_hash',
    'client_secret_expires_at',
  ]);
  // Field names only, and only name-shaped ones: a hand-edited row can't put text in the log.
  const extra = Object.keys(client)
    .filter((k) => !known.has(k))
    .map((k) => (/^[a-z_]{1,40}$/.test(k) ? k : '(other)'));
  if (extra.length > 0) failures.push(`unsupported fields: ${[...new Set(extra)].sort().join(', ')}`);
  return { plainHttp, failures };
}
