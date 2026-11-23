/**
 * The cut-over (#47-4, ADR-0002 D5, D6, D8): oidc-provider mounted behind the
 * AS stages of the real app (buildHttpApp), end to end, with YNAB mocked.
 *
 *   - one whole authorization: registration, /authorize, the consent page
 *     (the library's interaction), YNAB, the library's resume, the code
 *     exchange, /mcp, a refresh and a revocation;
 *   - D8's route answers: POST /authorize and every other wrong method is
 *     405, preflights are answered by cors-origin, discovery and /jwks are
 *     the library's;
 *   - D6's grant-guard: another client's credential, and a consumed refresh
 *     token or code replayed after it expired, each revoke the grant;
 *   - D5's client-auth over the library, fail closed;
 *   - the authorize guard's pre-validation and its redirect net;
 *   - unused registration access tokens go with their client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
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
import { exchangeCode as ynabExchangeCode, getYnabUserId, refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { TEST_TOKEN_PEPPER } from './helpers/token-hasher.js';
import { bearer, mcpInitialize } from './helpers/mcp-call.js';
import {
  PUBLIC_URL,
  REDIRECT_URI,
  CookieJar,
  browserFlow,
  exchangeCode,
  pkcePair,
  refresh,
  registerClient,
} from './helpers/oidc-app.js';

const RESOURCE = `${PUBLIC_URL}/mcp`;

let handle: HttpApp;
let app: Express;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(ynabExchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access',
    refreshToken: 'ynab-refresh',
    expiresAt: Date.now() + 7_200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue('ynab-user-1');
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-2',
    refreshToken: 'ynab-refresh-2',
    expiresAt: Date.now() + 7_200_000,
  }));
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
    })
  );
  app = handle.app;
});

afterEach(async () => {
  await handle.mcp.close();
  await created.storage?.close();
  created.storage = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function signIn(metadata: Record<string, unknown> = {}) {
  const client = await registerClient(app, metadata);
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(app, new CookieJar(), { clientId: client.clientId, challenge, resource: RESOURCE });
  const code = flow.params.get('code') as string;
  return { client, verifier, code, flow };
}

describe('one authorization through the mounted library', () => {
  it('registers, authorizes, exchanges, calls /mcp, refreshes and revokes', async () => {
    const { client, verifier, code, flow } = await signIn();
    expect(flow.params.get('iss')).toBe(`${PUBLIC_URL}/`);
    expect(flow.params.get('state')).toBe('client-state');
    const tokens = await exchangeCode(app, { clientId: client.clientId, code, verifier, resource: RESOURCE });
    expect(tokens.status).toBe(200);
    const access = tokens.body.access_token as string;
    expect((await mcpInitialize(app, bearer(access))).status).toBe(200);

    const refreshed = await refresh(app, { clientId: client.clientId, refreshToken: tokens.body.refresh_token as string });
    expect(refreshed.status).toBe(200);
    expect((await mcpInitialize(app, bearer(refreshed.body.access_token as string))).status).toBe(200);

    const revoked = await request(app)
      .post('/revoke')
      .type('form')
      .send({ token: refreshed.body.refresh_token, client_id: client.clientId });
    expect(revoked.status).toBe(200);
    expect((await mcpInitialize(app, bearer(refreshed.body.access_token as string))).status).toBe(401);
  });
});
