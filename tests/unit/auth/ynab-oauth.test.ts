/**
 * Unit tests for the YNAB OAuth client. `global.fetch` is mocked so no real
 * network calls occur; endpoints are overridden to a mock base.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getYnabUserId,
  type YnabOAuthConfig,
} from '../../../src/auth/ynab-oauth.js';

const cfg: YnabOAuthConfig = {
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  endpoints: {
    authorizeUrl: 'https://mock.ynab.test/oauth/authorize',
    tokenUrl: 'https://mock.ynab.test/oauth/token',
    apiBaseUrl: 'https://mock.ynab.test/v1',
  },
};

const originalFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  global.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('buildAuthorizeUrl', () => {
  it('includes required params and omits scope for full access', () => {
    const url = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: 'https://app/cb', state: 's-1', readOnly: false })
    );
    expect(url.origin + url.pathname).toBe('https://mock.ynab.test/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('s-1');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('includes scope=read-only when readOnly is true', () => {
    const url = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: 'https://app/cb', state: 's-2', readOnly: true })
    );
    expect(url.searchParams.get('scope')).toBe('read-only');
  });
});

describe('exchangeCode', () => {
  it('POSTs the form fields and returns a token set with a future expiry', async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(
      jsonResponse({
        access_token: 'access-1',
        token_type: 'bearer',
        expires_in: 7200,
        refresh_token: 'refresh-1',
      })
    );

    const before = Date.now();
    const tokens = await exchangeCode(cfg, { code: 'auth-code', redirectUri: 'https://app/cb' });

    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBeGreaterThan(before);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 7200 * 1000);

    expect(mock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://mock.ynab.test/oauth/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    const form = new URLSearchParams(init.body as string);
    expect(form.get('client_id')).toBe('client-abc');
    expect(form.get('client_secret')).toBe('secret-xyz');
    expect(form.get('redirect_uri')).toBe('https://app/cb');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code');
  });
});

describe('refreshAccessToken', () => {
  it('POSTs the refresh grant and returns a new token set', async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(
      jsonResponse({
        access_token: 'access-2',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      })
    );

    const before = Date.now();
    const tokens = await refreshAccessToken(cfg, 'old-refresh');

    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBe('refresh-2');
    expect(tokens.expiresAt).toBeGreaterThan(before);

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('old-refresh');
    expect(form.get('client_id')).toBe('client-abc');
    expect(form.get('client_secret')).toBe('secret-xyz');
  });
});

describe('getYnabUserId', () => {
  it('returns the user id and sends a bearer token', async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(jsonResponse({ data: { user: { id: 'user-42' } } }));

    const id = await getYnabUserId('access-token-123', cfg.endpoints);
    expect(id).toBe('user-42');

    const [calledUrl, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://mock.ynab.test/v1/user');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-123');
  });
});

describe('sanitized errors', () => {
  it('throws a sanitized error on non-2xx without leaking the token', async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(
      jsonResponse({ error: 'invalid_grant', error_description: 'bad code' }, 400)
    );

    await expect(
      exchangeCode(cfg, { code: 'secret-code-value', redirectUri: 'https://app/cb' })
    ).rejects.toThrow(/status 400/);

    let message = '';
    try {
      mock.mockResolvedValue(
        jsonResponse({ error: 'invalid_grant', error_description: 'bad code' }, 400)
      );
      await refreshAccessToken(cfg, 'super-secret-refresh-token');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('invalid_grant');
    expect(message).toContain('bad code');
    expect(message).not.toContain('super-secret-refresh-token');
    expect(message).not.toContain('secret-xyz');
  });

  it('throws when the user response is missing the id', async () => {
    const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(jsonResponse({ data: { user: {} } }));
    await expect(getYnabUserId('tok', cfg.endpoints)).rejects.toThrow(/user id/);
  });
});
