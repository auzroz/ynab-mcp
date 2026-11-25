/**
 * The account tools (#53c) end to end over /mcp: registered in OAuth mode
 * only, scoped to the signed-in user, a revoked connection's token refused
 * with 401 on its next request, and ynab_disconnect erasing the account and
 * dropping this replica's per-user state (the registry entry and the YNAB
 * token resolver's cache). Only YNAB's endpoints are mocked; storage is
 * memory (the drivers are covered in tests/unit/tools/connections/).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Express } from 'express';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { exchangeCode, getYnabUserId, refreshAccessToken } from '../../src/auth/ynab-oauth.js';
import { YnabTokenResolver } from '../../src/auth/user-session.js';
import { YNAB_REVOKE_STEPS } from '../../src/auth/ynab-revoke-text.js';
import { ACCOUNT_TOOL_NAMES } from '../../src/tools/connections/policy.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { bearer, mcpConnect, mcpInitialize, ynabToken, type McpConnection } from './helpers/mcp-call.js';
import {
  CookieJar,
  browserFlow,
  exchangeCode as exchangeAuthorizationCode,
  pkcePair,
  registerClient,
} from './helpers/oidc-app.js';

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const handles: HttpApp[] = [];

async function startOauthApp(overrides: { allowWrite?: boolean } = {}): Promise<HttpApp> {
  const handle = await buildHttpApp(
    makeHttpConfig({
      publicUrl: PUBLIC_URL,
      resourceUrl: RESOURCE,
      authMode: 'oauth',
      oauthClientId: 'ynab-client-id',
      oauthClientSecret: 'ynab-client-secret',
      encryptionKey: randomBytes(32).toString('base64'),
      readOnly: false,
      allowWrite: overrides.allowWrite ?? true,
    })
  );
  handles.push(handle);
  return handle;
}

/** `userId` connects a new client named `name` at `choice`; returns its access token. */
async function connect(app: Express, userId: string, choice: 'read-only' | 'read-write', name: string): Promise<string> {
  vi.mocked(getYnabUserId).mockResolvedValue(userId);
  const { clientId } = await registerClient(app, { client_name: name });
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(app, new CookieJar(), {
    clientId,
    challenge,
    scope: 'read-only read-write',
    resource: RESOURCE,
    choice,
  });
  const token = await exchangeAuthorizationCode(app, {
    clientId,
    code: flow.params.get('code') as string,
    verifier,
    resource: RESOURCE,
  });
  expect(token.status).toBe(200);
  return token.body.access_token as string;
}

async function call(conn: McpConnection, name: string, args: Record<string, unknown> = {}) {
  const res = await conn.callTool(name, args);
  return { isError: res.isError, body: JSON.parse(res.text) as Record<string, any>, text: res.text };
}

/** The family_id of the calling connection, from its own listing. */
async function ownFamilyId(conn: McpConnection): Promise<string> {
  const list = (await call(conn, 'ynab_list_connections')).body['connections'] as Array<Record<string, any>>;
  return list.find((c) => c['this_connection'] === true)?.['family_id'] as string;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(exchangeCode).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-0',
    refreshToken: 'ynab-refresh-0',
    expiresAt: Date.now() + 7200_000,
  }));
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-1',
    refreshToken: 'ynab-refresh-1',
    expiresAt: Date.now() + 7200_000,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 }))
  );
});

afterEach(async () => {
  for (const h of handles.splice(0)) await h.mcp.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('account tools over /mcp (oauth mode)', () => {
  it("list and revoke: the user's own connections only, and a revoked connection's token gets 401", async () => {
    const { app } = await startOauthApp();
    const laptop = await connect(app, 'u1', 'read-write', 'Laptop');
    const phone = await connect(app, 'u1', 'read-only', 'Phone');
    const theirs = await connect(app, 'u2', 'read-write', 'Theirs');
    const conn = await mcpConnect(app, bearer(laptop));
    const theirConn = await mcpConnect(app, bearer(theirs));

    const names = await conn.listTools();
    for (const name of ACCOUNT_TOOL_NAMES) expect(names).toContain(name);

    const listed = await call(conn, 'ynab_list_connections');
    expect(listed.isError).toBe(false);
    const list = listed.body['connections'] as Array<Record<string, any>>;
    expect(list.map((c) => [c['client_name'], c['access'], c['this_connection']])).toEqual([
      ['Laptop', 'read-write', true],
      ['Phone', 'read-only', false],
    ]);
    const phoneId = list[1]?.['family_id'] as string;
    const theirId = await ownFamilyId(theirConn);

    // Another user's id: the same reply as an unknown one, and their connection keeps working.
    const foreign = await call(conn, 'ynab_revoke_connection', { family_id: theirId });
    const unknown = await call(conn, 'ynab_revoke_connection', { family_id: 'Z'.repeat(43) });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toBe(unknown.text);
    expect((await call(theirConn, 'ynab_list_connections')).isError).toBe(false);

    // Revoke the phone: its next request is refused at the bearer stage.
    expect((await mcpInitialize(app, bearer(phone))).status).toBe(200);
    const revoked = await call(conn, 'ynab_revoke_connection', { family_id: phoneId });
    expect(revoked).toMatchObject({ isError: false, body: { revoked: true, this_connection: false } });
    expect((await mcpInitialize(app, bearer(phone))).status).toBe(401);
    expect((await mcpInitialize(app, bearer(laptop))).status).toBe(200);
  });

  it('a client may revoke its own connection: the reply says so and its next request gets 401', async () => {
    const { app } = await startOauthApp();
    const laptop = await connect(app, 'u1', 'read-write', 'Laptop');
    const conn = await mcpConnect(app, bearer(laptop));
    const res = await call(conn, 'ynab_revoke_connection', { family_id: await ownFamilyId(conn) });
    expect(res.body).toMatchObject({ revoked: true, this_connection: true });
    expect((await mcpInitialize(app, bearer(laptop))).status).toBe(401);
  });

  it("disconnect: refused without the exact confirmation; with it, the account is erased and this replica's state dropped", async () => {
    const { app, registry } = await startOauthApp();
    const laptop = await connect(app, 'u1', 'read-write', 'Laptop');
    const phone = await connect(app, 'u1', 'read-write', 'Phone');
    const theirs = await connect(app, 'u2', 'read-write', 'Theirs');
    const conn = await mcpConnect(app, bearer(laptop));
    await mcpConnect(app, bearer(theirs));
    const invalidate = vi.spyOn(YnabTokenResolver.prototype, 'invalidate');

    const refused = await call(conn, 'ynab_disconnect', { confirm: 'yes' });
    expect(refused.isError).toBe(true);
    expect(refused.body['type']).toBe('validation_error');
    expect((await mcpInitialize(app, bearer(laptop))).status).toBe(200);
    expect(registry.size).toBe(2);

    const done = await call(conn, 'ynab_disconnect', { confirm: 'DISCONNECT' });
    expect(done.isError).toBe(false);
    expect(done.body['disconnected']).toBe(true);
    expect(done.body['ynab_authorization']).toContain(YNAB_REVOKE_STEPS);
    expect(invalidate).toHaveBeenCalledWith('u1');
    // u1's registry entry is gone (its request has finished); u2's is kept.
    expect(registry.size).toBe(1);

    // Every connection of the user is refused; another user's is not.
    expect((await mcpInitialize(app, bearer(laptop))).status).toBe(401);
    expect((await mcpInitialize(app, bearer(phone))).status).toBe(401);
    expect((await mcpInitialize(app, bearer(theirs))).status).toBe(200);
  });

  it('a read-only connection (restrictive default) lists connections but may not revoke or disconnect', async () => {
    const { app } = await startOauthApp();
    const ro = await connect(app, 'u1', 'read-only', 'Viewer');
    const conn = await mcpConnect(app, bearer(ro));
    const names = await conn.listTools();
    expect(names).toContain('ynab_list_connections');
    expect(names).not.toContain('ynab_revoke_connection');
    expect(names).not.toContain('ynab_disconnect');
    const id = await ownFamilyId(conn);
    for (const [name, args] of [
      ['ynab_revoke_connection', { family_id: id }],
      ['ynab_disconnect', { confirm: 'DISCONNECT' }],
    ] as const) {
      const res = await call(conn, name, args);
      expect(res.isError, name).toBe(true);
      expect(res.body, name).toMatchObject({ type: 'account_change_not_allowed', reason: 'scope' });
    }
    expect((await mcpInitialize(app, bearer(ro))).status).toBe(200);
  });

  it('on an instance with writes off (the 0.5.0 default), revoke and disconnect are refused as read_only', async () => {
    // allowWrite false: the consent page offers read-only only, and the operator setting is named first.
    const { app } = await startOauthApp({ allowWrite: false });
    const access = await connect(app, 'u1', 'read-only', 'Laptop');
    const conn = await mcpConnect(app, bearer(access));
    expect((await call(conn, 'ynab_list_connections')).isError).toBe(false);
    const res = await call(conn, 'ynab_disconnect', { confirm: 'DISCONNECT' });
    expect(res.body).toMatchObject({ type: 'account_change_not_allowed', reason: 'read_only' });
    expect((await mcpInitialize(app, bearer(access))).status).toBe(200);
  });
});

describe('account tools are absent in header mode', () => {
  it('neither listed nor callable by name', async () => {
    const handle = await buildHttpApp(makeHttpConfig({ authMode: 'header', readOnly: false }));
    handles.push(handle);
    const conn = await mcpConnect(handle.app, ynabToken('header-token'));
    const names = await conn.listTools();
    for (const name of ACCOUNT_TOOL_NAMES) {
      expect(names).not.toContain(name);
      const res = await conn.callTool(name, name === 'ynab_disconnect' ? { confirm: 'DISCONNECT' } : {});
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toMatch(/Unknown tool/);
    }
  });
});
