/**
 * Dependency-free client for YNAB's OAuth 2.0 Authorization Code flow.
 *
 * Covers building the authorize URL, exchanging an authorization code for a
 * token set, refreshing an access token, and resolving the YNAB user id. All
 * token-bearing failures throw sanitized errors that never echo secrets.
 */

/** Default YNAB OAuth/API endpoints. Overridable per config for tests. */
export const YNAB_AUTHORIZE_URL = 'https://app.ynab.com/oauth/authorize';
export const YNAB_TOKEN_URL = 'https://app.ynab.com/oauth/token';
export const YNAB_API_BASE_URL = 'https://api.ynab.com/v1';

/** Endpoint overrides so tests can point at a mock server. */
export interface YnabOAuthEndpoints {
  authorizeUrl?: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
}

export interface YnabOAuthConfig {
  clientId: string;
  clientSecret: string;
  endpoints?: YnabOAuthEndpoints;
}

/** A resolved token set with the expiry converted to epoch milliseconds. */
export interface YnabTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry as epoch milliseconds (Date.now() + expires_in * 1000). */
  expiresAt: number;
}

/** Raw token response shape from YNAB's token endpoint. */
interface YnabTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Build the authorize URL a user visits to grant access. */
export function buildAuthorizeUrl(
  cfg: YnabOAuthConfig,
  params: { redirectUri: string; state: string; readOnly: boolean }
): string {
  const base = cfg.endpoints?.authorizeUrl ?? YNAB_AUTHORIZE_URL;
  const url = new URL(base);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);
  if (params.readOnly) {
    url.searchParams.set('scope', 'read-only');
  }
  return url.toString();
}

/**
 * Extract a sanitized error message from a non-2xx token/API response body.
 * Never includes token or secret material — only status and any error fields.
 */
async function sanitizedError(res: Response, context: string): Promise<Error> {
  let detail = '';
  try {
    const body: unknown = await res.json();
    if (isRecord(body)) {
      const err = typeof body['error'] === 'string' ? body['error'] : undefined;
      const desc =
        typeof body['error_description'] === 'string' ? body['error_description'] : undefined;
      const parts = [err, desc].filter((p): p is string => p !== undefined);
      if (parts.length > 0) {
        detail = `: ${parts.join(' - ')}`;
      }
    }
  } catch {
    // Body was not JSON; fall back to status only. Never surface raw body text.
  }
  return new Error(`${context} failed with status ${res.status}${detail}`);
}

/** Parse a token response defensively and compute the absolute expiry. */
function parseTokenSet(body: unknown): YnabTokenSet {
  if (!isRecord(body)) {
    throw new Error('YNAB token response was not an object');
  }
  const { access_token, refresh_token, expires_in } = body as Partial<YnabTokenResponse>;
  if (typeof access_token !== 'string' || access_token === '') {
    throw new Error('YNAB token response missing access_token');
  }
  if (typeof refresh_token !== 'string' || refresh_token === '') {
    throw new Error('YNAB token response missing refresh_token');
  }
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in)) {
    throw new Error('YNAB token response missing expires_in');
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: Date.now() + expires_in * 1000,
  };
}

async function postToken(cfg: YnabOAuthConfig, form: URLSearchParams): Promise<YnabTokenSet> {
  const tokenUrl = cfg.endpoints?.tokenUrl ?? YNAB_TOKEN_URL;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    throw await sanitizedError(res, 'YNAB token request');
  }
  const body: unknown = await res.json();
  return parseTokenSet(body);
}

/** Exchange an authorization code for a token set. */
export function exchangeCode(
  cfg: YnabOAuthConfig,
  params: { code: string; redirectUri: string }
): Promise<YnabTokenSet> {
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
    code: params.code,
  });
  return postToken(cfg, form);
}

/** Exchange a refresh token for a fresh token set. */
export function refreshAccessToken(
  cfg: YnabOAuthConfig,
  refreshToken: string
): Promise<YnabTokenSet> {
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return postToken(cfg, form);
}

/** Resolve the YNAB user id for a given access token. */
export async function getYnabUserId(
  accessToken: string,
  endpoints?: YnabOAuthEndpoints
): Promise<string> {
  const base = endpoints?.apiBaseUrl ?? YNAB_API_BASE_URL;
  const res = await fetch(`${base}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw await sanitizedError(res, 'YNAB user request');
  }
  const body: unknown = await res.json();
  if (!isRecord(body)) {
    throw new Error('YNAB user response was not an object');
  }
  const data = body['data'];
  if (!isRecord(data)) {
    throw new Error('YNAB user response missing data');
  }
  const user = data['user'];
  if (!isRecord(user) || typeof user['id'] !== 'string' || user['id'] === '') {
    throw new Error('YNAB user response missing user id');
  }
  return user['id'];
}
