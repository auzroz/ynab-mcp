/**
 * YNAB_OAUTH_ALLOW_WRITE is enforced on every request, not only at consent
 * (#56). A connection granted read-write while writes were allowed (as on
 * 0.4.x, where the default was true) cannot write once the instance runs with
 * allowWrite false, and writes again when the operator opts back in.
 *
 * Two apps share one storage and one encryption key, standing for the same
 * instance before and after the operator's config change. Only YNAB's external
 * endpoints are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

// Every app built in this file uses the same storage.
const shared = vi.hoisted(() => ({ storage: undefined as Storage | undefined }));
vi.mock('../../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/index.js')>('../../src/storage/index.js');
  return {
    ...actual,
    createStorage: async (...args: Parameters<typeof actual.createStorage>) => {
      shared.storage ??= await actual.createStorage(...args);
      return shared.storage;
    },
  };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { exchangeCode, getYnabUserId, refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { tools } from '../../src/tools/index.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { cookieHeaderFrom } from './helpers/consent-cookie.js';

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const CALLBACK = 'https://client.example/cb';
const ACCEPT = 'application/json, text/event-stream';
const READ_TOOLS = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
const ALL_TOOLS = tools.map((t) => t.name);
const encryptionKey = randomBytes(32).toString('base64');

const fetchMock = vi.fn<typeof fetch>();
const handles: HttpApp[] = [];

async function startApp(overrides: { allowWrite: boolean; readOnly?: boolean }): Promise<Express> {
  const handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey,
      readOnly: overrides.readOnly ?? false,
      allowWrite: overrides.allowWrite,
    })
  );
  handles.push(handle);
  return handle.app;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  shared.storage = undefined;
  vi.mocked(exchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-0',
    refreshToken: 'ynab-refresh-0',
    expiresAt: Date.now() + 7200_000,
  }));
  // Each app has its own token cache, so the second one refreshes the user's YNAB token.
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-1',
    refreshToken: 'ynab-refresh-1',
    expiresAt: Date.now() + 7200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue('ynab-user-rw');
  fetchMock.mockReset().mockImplementation(
    async () =>
      new Response(JSON.stringify({ data: { category_group: { id: 'g1', name: 'Created', categories: [] } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  for (const h of handles.splice(0)) await h.sessions.close();
  await shared.storage?.close();
  shared.storage = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Registers, consents (read-write), and exchanges the code against `app`; returns the access token. */
async function connectReadWrite(app: Express): Promise<string> {
  const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: [CALLBACK], client_name: 'write-policy', token_endpoint_auth_method: 'none' });
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const consent = await request(app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'read-only read-write',
    state: 's',
    resource: RESOURCE,
  });
  expect(consent.status).toBe(200);
  const cookie = cookieHeaderFrom(consent);
  let start: string | undefined;
  for (const m of consent.text.matchAll(/<a class="btn" href="([^"]+)"/g)) {
    const url = new URL((m[1] as string).replaceAll('&amp;', '&'));
    if (url.searchParams.get('scope') === 'read-write') start = url.pathname + url.search;
  }
  if (start === undefined) throw new Error('consent page does not offer read-write');

  const toYnab = await request(app).get(start).set('Cookie', cookie);
  const state = new URL(toYnab.headers['location'] as string).searchParams.get('state') as string;
  const back = await request(app).get('/oauth/ynab/callback').set('Cookie', cookie).query({ code: 'ynab-code', state });
  const code = new URL(back.headers['location'] as string).searchParams.get('code') as string;

  const token = await request(app).post('/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
    resource: RESOURCE,
  });
  expect(token.status).toBe(200);
  expect(token.body.scope).toBe('read-only read-write');
  return token.body.access_token as string;
}

function rpc(res: request.Response): Record<string, any> {
  if (res.body && typeof res.body === 'object' && 'jsonrpc' in res.body) return res.body;
  const data = res.text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .at(-1);
  return JSON.parse(data as string) as Record<string, any>;
}

function post(app: Express, access: string, sessionId?: string): request.Test {
  let req = request(app).post('/mcp').set('Authorization', `Bearer ${access}`).set('Accept', ACCEPT);
  if (sessionId) req = req.set('mcp-session-id', sessionId).set('mcp-protocol-version', '2025-06-18');
  return req;
}

async function openSession(app: Express, access: string): Promise<string> {
  const init = await post(app, access).send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  expect(init.status, `${JSON.stringify(init.body)} ${String(init.headers['www-authenticate'])}`).toBe(200);
  const sessionId = init.headers['mcp-session-id'] as string;
  await post(app, access, sessionId).send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return sessionId;
}

async function listToolNames(app: Express, access: string, sessionId: string): Promise<string[]> {
  const res = await post(app, access, sessionId).send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  return (rpc(res)['result']['tools'] as Array<{ name: string }>).map((t) => t.name);
}

async function tryWrite(app: Express, access: string, sessionId: string): Promise<{ isError: boolean; text: string }> {
  const res = await post(app, access, sessionId).send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'ynab_create_category_group', arguments: { budget_id: 'plan-1', name: 'Sneaky' } },
  });
  const result = rpc(res)['result'];
  return { isError: result['isError'] === true, text: result['content'][0]['text'] as string };
}

describe('YNAB_OAUTH_ALLOW_WRITE is enforced on every request', () => {
  it('a read-write grant from when writes were allowed cannot write once allowWrite is false', async () => {
    // Before the upgrade: the instance allows writes, and the user consents to read-write.
    const before = await startApp({ allowWrite: true });
    const access = await connectReadWrite(before);
    const beforeSession = await openSession(before, access);
    expect(await listToolNames(before, access, beforeSession)).toEqual(ALL_TOOLS);

    // After: the same storage and token, the instance's allowWrite is false (the 0.5.0 default).
    const after = await startApp({ allowWrite: false });
    const session = await openSession(after, access);
    expect(await listToolNames(after, access, session)).toEqual(READ_TOOLS);
    const refused = await tryWrite(after, access, session);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.text).type).toBe('read_only_mode');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the same grant writes again once the operator opts in', async () => {
    const off = await startApp({ allowWrite: false });
    // The consent page does not offer read-write with allowWrite false, so the grant comes from an instance that allowed it.
    const on = await startApp({ allowWrite: true });
    const access = await connectReadWrite(on);

    const offSession = await openSession(off, access);
    expect((await tryWrite(off, access, offSession)).isError).toBe(true);

    const onSession = await openSession(on, access);
    const allowed = await tryWrite(on, access, onSession);
    expect(allowed.isError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('YNAB_READ_ONLY=true still wins when allowWrite is true', async () => {
    const on = await startApp({ allowWrite: true });
    const access = await connectReadWrite(on);
    const readOnly = await startApp({ allowWrite: true, readOnly: true });
    const session = await openSession(readOnly, access);
    expect((await tryWrite(readOnly, access, session)).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with allowWrite false the consent page offers only read-only', async () => {
    const off = await startApp({ allowWrite: false });
    const reg = await request(off)
      .post('/register')
      .send({ redirect_uris: [CALLBACK], client_name: 'ro', token_endpoint_auth_method: 'none' });
    const consent = await request(off).get('/authorize').query({
      response_type: 'code',
      client_id: reg.body.client_id,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'read-only read-write',
      state: 's',
      resource: RESOURCE,
    });
    expect(consent.status).toBe(200);
    expect(consent.text).not.toMatch(/scope=read-write/);
  });
});
