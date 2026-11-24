/**
 * #64a (OAUTH-22): `resource` required at `/authorize` for clients registered
 * on 0.5.0 or later, and optional at `/token` (the grant's resource applies;
 * a foreign one is refused without spending anything), through the real app
 * (buildHttpApp). Clients registered before 0.5.0 (a `crypto.randomUUID()`
 * id, as M4 converted them) keep working without it, and
 * `MCP_REQUIRE_RESOURCE=false` turns the requirement off. YNAB is mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return {
    ...actual,
    exchangeCode: vi.fn(async () => ({ accessToken: 'ya', refreshToken: 'yr', expiresAt: Date.now() + 7_200_000 })),
    getYnabUserId: vi.fn(async () => 'ynab-user-1'),
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'ya2', refreshToken: 'yr2', expiresAt: Date.now() + 7_200_000 })),
  };
});

const created = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      created.storage = await actual.createStorage(...args);
      return created.storage;
    },
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import type { HttpConfig } from '../../src/config/environment.js';
import { FOREIGN_RESOURCE_DESCRIPTION, RESOURCE_REQUIRED_DESCRIPTION } from '../../src/auth/resource-required.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_HASHER, TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { plantClient } from './helpers/oauth-state.js';
import { bearer, mcpInitialize } from './helpers/mcp-call.js';
import {
  PUBLIC_URL,
  REDIRECT_URI,
  RESOURCE,
  CookieJar,
  authorizeUrl,
  browserFlow,
  exchangeCode,
  pkcePair,
  refresh,
  registerClient,
} from './helpers/oidc-app.js';

let handle: HttpApp | undefined;

afterEach(async () => {
  await handle?.mcp.close();
  handle = undefined;
  await created.storage?.close();
  created.storage = undefined;
  vi.restoreAllMocks();
});

async function app(overrides: Partial<HttpConfig> = {}): Promise<Express> {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      readOnly: false,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey: randomBytes(32).toString('base64'),
      tokenPepper: TEST_TOKEN_PEPPER,
      ...overrides,
    })
  );
  return handle.app;
}

const FOREIGN = { error: 'invalid_target', error_description: FOREIGN_RESOURCE_DESCRIPTION };

/** The audience (`aud`) stored for an access token. */
async function audienceOf(accessToken: string): Promise<unknown> {
  const key = TEST_TOKEN_HASHER.libraryStorageKey('access', accessToken) as string;
  const row = await (created.storage as Storage).findOAuthRow(key);
  return row ? (JSON.parse(row.payload) as { aud?: unknown }).aud : undefined;
}

/** A client as 0.4.x registered it (a UUID id) and M4 converted it. */
async function plantPre050Client(): Promise<string> {
  const clientId = randomUUID();
  await plantClient(created.storage as Storage, {
    client_id: clientId,
    client_id_issued_at: 1_760_000_000,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'A 0.4.x client',
  });
  return clientId;
}

/** Sign in with resource throughout; returns the client, the verifier and the token response. */
async function signedIn(on: Express, clientId: string) {
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(on, new CookieJar(), { clientId, challenge });
  const tokens = await exchangeCode(on, { clientId, code: flow.params.get('code') as string, verifier });
  expect(tokens.status).toBe(200);
  return tokens.body as { access_token: string; refresh_token: string };
}

describe('a client registered on 0.5.0 (MCP_REQUIRE_RESOURCE on, the default)', () => {
  it('/authorize without resource: invalid_target, redirected to a verified client with state and iss', async () => {
    const on = await app({ verifiedRedirectUris: [REDIRECT_URI] });
    const { clientId } = await registerClient(on);
    const res = await request(on).get(authorizeUrl({ clientId, challenge: pkcePair().challenge, resource: undefined }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers['location'] as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('error_description')).toBe(RESOURCE_REQUIRED_DESCRIPTION);
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(`${PUBLIC_URL}/`);
  });

  it('/authorize without resource from an unverified client: this server\'s page, never a redirect', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const res = await request(on).get(authorizeUrl({ clientId, challenge: pkcePair().challenge, resource: undefined }));
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('invalid_target');
  });

  it('/authorize with an empty resource is refused the same way', async () => {
    const on = await app({ verifiedRedirectUris: [REDIRECT_URI] });
    const { clientId } = await registerClient(on);
    const res = await request(on).get(authorizeUrl({ clientId, challenge: pkcePair().challenge, resource: '' }));
    expect(new URL(res.headers['location'] as string).searchParams.get('error')).toBe('invalid_target');
  });

  it('the code exchange and the refresh without resource succeed, with the authorized resource as audience', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(on, new CookieJar(), { clientId, challenge });
    const tokens = await exchangeCode(on, { clientId, code: flow.params.get('code') as string, verifier, resource: null });
    expect(tokens.status).toBe(200);
    expect(await audienceOf(tokens.body.access_token as string)).toBe(RESOURCE);
    const rotated = await refresh(on, { clientId, refreshToken: tokens.body.refresh_token as string, resource: null });
    expect(rotated.status).toBe(200);
    expect(await audienceOf(rotated.body.access_token as string)).toBe(RESOURCE);
    expect((await mcpInitialize(on, bearer(rotated.body.access_token as string))).status).toBe(200);
  });

  it('the code exchange with a foreign resource: invalid_target, and the code is not spent', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(on, new CookieJar(), { clientId, challenge });
    const code = flow.params.get('code') as string;
    const refused = await exchangeCode(on, { clientId, code, verifier, resource: 'https://evil.example/mcp' });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(FOREIGN);
    // No credential in the answer.
    expect(refused.text).not.toContain(code);
    expect(refused.text).not.toContain(verifier);
    const ok = await exchangeCode(on, { clientId, code, verifier });
    expect(ok.status).toBe(200);
    expect((await mcpInitialize(on, bearer(ok.body.access_token as string))).status).toBe(200);
  });

  it('a refresh with a foreign resource: invalid_target, and the refresh token is not spent', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const tokens = await signedIn(on, clientId);
    const refused = await refresh(on, { clientId, refreshToken: tokens.refresh_token, resource: `${PUBLIC_URL}/other` });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(FOREIGN);
    expect(refused.text).not.toContain(tokens.refresh_token);
    expect(refused.text).not.toContain(tokens.access_token);
    const ok = await refresh(on, { clientId, refreshToken: tokens.refresh_token });
    expect(ok.status).toBe(200);
  });

  it('a /token resource in another spelling of this server\'s is accepted', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const tokens = await signedIn(on, clientId);
    const ok = await refresh(on, { clientId, refreshToken: tokens.refresh_token, resource: `${RESOURCE}/` });
    expect(ok.status).toBe(200);
  });

  it('a replayed refresh token without resource still revokes its grant (grant-guard runs first)', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const tokens = await signedIn(on, clientId);
    const rotated = await refresh(on, { clientId, refreshToken: tokens.refresh_token });
    expect(rotated.status).toBe(200);
    // Its successor is in use, so the old token is reuse.
    expect((await mcpInitialize(on, bearer(rotated.body.access_token as string))).status).toBe(200);
    const replay = await refresh(on, { clientId, refreshToken: tokens.refresh_token, resource: null });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await mcpInitialize(on, bearer(rotated.body.access_token as string))).status).toBe(401);
  });

  it('with resource at every step, it signs in, refreshes and calls /mcp', async () => {
    const on = await app();
    const { clientId } = await registerClient(on);
    const tokens = await signedIn(on, clientId);
    const rotated = await refresh(on, { clientId, refreshToken: tokens.refresh_token });
    expect(rotated.status).toBe(200);
    expect((await mcpInitialize(on, bearer(rotated.body.access_token as string))).status).toBe(200);
  });
});

describe('a client registered before 0.5.0 (converted by M4)', () => {
  it('signs in, exchanges and refreshes without resource', async () => {
    const on = await app();
    const clientId = await plantPre050Client();
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(on, new CookieJar(), { clientId, challenge, resource: undefined });
    const tokens = await exchangeCode(on, { clientId, code: flow.params.get('code') as string, verifier, resource: null });
    expect(tokens.status).toBe(200);
    const rotated = await refresh(on, { clientId, refreshToken: tokens.body.refresh_token as string, resource: null });
    expect(rotated.status).toBe(200);
    expect((await mcpInitialize(on, bearer(rotated.body.access_token as string))).status).toBe(200);
  });

  it('a resource it does send must still be this server\'s', async () => {
    const on = await app({ verifiedRedirectUris: [REDIRECT_URI] });
    const clientId = await plantPre050Client();
    const res = await request(on).get(
      authorizeUrl({ clientId, challenge: pkcePair().challenge, resource: 'https://evil.example/mcp' })
    );
    expect(new URL(res.headers['location'] as string).searchParams.get('error')).toBe('invalid_target');
  });
});

describe('MCP_REQUIRE_RESOURCE=false', () => {
  it('a client registered on 0.5.0 signs in, exchanges and refreshes without resource', async () => {
    const on = await app({ requireResource: false });
    const { clientId } = await registerClient(on);
    const { verifier, challenge } = pkcePair();
    const flow = await browserFlow(on, new CookieJar(), { clientId, challenge, resource: undefined });
    const tokens = await exchangeCode(on, { clientId, code: flow.params.get('code') as string, verifier, resource: null });
    expect(tokens.status).toBe(200);
    const rotated = await refresh(on, { clientId, refreshToken: tokens.body.refresh_token as string, resource: null });
    expect(rotated.status).toBe(200);
    expect((await mcpInitialize(on, bearer(rotated.body.access_token as string))).status).toBe(200);
  });

  it('a foreign resource is still refused', async () => {
    const on = await app({ requireResource: false, verifiedRedirectUris: [REDIRECT_URI] });
    const { clientId } = await registerClient(on);
    const res = await request(on).get(
      authorizeUrl({ clientId, challenge: pkcePair().challenge, resource: 'https://evil.example/mcp' })
    );
    expect(new URL(res.headers['location'] as string).searchParams.get('error')).toBe('invalid_target');
  });
});
