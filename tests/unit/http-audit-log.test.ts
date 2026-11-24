/**
 * #60a over HTTP (oauth mode): every write attempt lands in the storage
 * driver's audit log with the user, the MCP client, its grant and the
 * request, including refused ones (read-only mode, a read-only grant); and
 * ynab_rate_limit_status reports the calling client's share of the user's
 * requests (#58). One storage is shared by the apps of a test; only YNAB's
 * external endpoints are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { Storage } from '../../src/storage/types.js';

vi.mock('../../src/auth/ynab-oauth.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/auth/ynab-oauth.js')>('../../src/auth/ynab-oauth.js');
  return { ...actual, exchangeCode: vi.fn(), getYnabUserId: vi.fn(), refreshAccessToken: vi.fn() };
});

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
import { makeHttpConfig } from './helpers/http-config.js';
import {
  CookieJar,
  browserFlow,
  exchangeCode as exchangeAuthorizationCode,
  pkcePair,
  registerClient,
} from './helpers/oidc-app.js';

const PUBLIC_URL = 'https://mcp.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;
const ACCEPT = 'application/json, text/event-stream';
const USER = 'ynab-user-audit';
const encryptionKey = randomBytes(32).toString('base64');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fetchMock = vi.fn<typeof fetch>();
const handles: HttpApp[] = [];

async function startApp(
  overrides: { allowWrite: boolean; readOnly?: boolean; requestTimeoutMs?: number } = { allowWrite: true }
): Promise<Express> {
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
      ...(overrides.requestTimeoutMs !== undefined ? { requestTimeoutMs: overrides.requestTimeoutMs } : {}),
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
  vi.mocked(refreshAccessToken).mockReset().mockImplementation(async () => ({
    accessToken: 'ynab-access-1',
    refreshToken: 'ynab-refresh-1',
    expiresAt: Date.now() + 7200_000,
  }));
  vi.mocked(getYnabUserId).mockReset().mockResolvedValue(USER);
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
  for (const h of handles.splice(0)) await h.mcp.close();
  await shared.storage?.close();
  shared.storage = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Registers a client, consents with `choice` and exchanges the code; returns the client id and access token. */
async function connect(app: Express, choice: 'read-only' | 'read-write'): Promise<{ clientId: string; access: string }> {
  const { clientId } = await registerClient(app, { client_name: `audit-${choice}` });
  const { verifier, challenge } = pkcePair();
  const flow = await browserFlow(app, new CookieJar(), {
    clientId,
    challenge,
    scope: choice === 'read-write' ? 'read-only read-write' : 'read-only',
    resource: RESOURCE,
    state: 's',
    choice,
  });
  const code = flow.params.get('code') as string;
  const token = await exchangeAuthorizationCode(app, { clientId, code, verifier, resource: RESOURCE });
  expect(token.status).toBe(200);
  return { clientId, access: token.body.access_token as string };
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

function post(app: Express, access: string, protocolVersion?: string): request.Test {
  let req = request(app).post('/mcp').set('Authorization', `Bearer ${access}`).set('Accept', ACCEPT);
  if (protocolVersion) req = req.set('mcp-protocol-version', protocolVersion);
  return req;
}

async function openSession(app: Express, access: string): Promise<string> {
  const init = await post(app, access).send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  expect(init.status).toBe(200);
  const protocolVersion = rpc(init)['result']['protocolVersion'] as string;
  await post(app, access, protocolVersion).send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return protocolVersion;
}

async function callTool(
  app: Express,
  access: string,
  protocolVersion: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; body: Record<string, any> }> {
  const res = await post(app, access, protocolVersion).send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = rpc(res)['result'];
  return { isError: result['isError'] === true, body: JSON.parse(result['content'][0]['text'] as string) };
}

const PLAN = '55555555-5555-4555-8555-555555555555';
const createGroup = { budget_id: PLAN, name: 'Sentinel Group Name' };

describe('the audit log over HTTP (#60a)', () => {
  it('records a write with the user, client, grant and request; the tool lists it', async () => {
    const app = await startApp();
    const { clientId, access } = await connect(app, 'read-write');
    const session = await openSession(app, access);

    expect((await callTool(app, access, session, 'ynab_create_category_group', createGroup)).isError).toBe(false);
    expect((await callTool(app, access, session, 'ynab_create_category_group', createGroup)).isError).toBe(false);

    const rows = await shared.storage!.listAuditEntries(USER, {}, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      userId: USER,
      clientId,
      tool: 'ynab_create_category_group',
      operation: 'create',
      resourceType: 'category_group',
      resourceId: 'g1',
      budgetId: PLAN,
      outcome: 'success',
    });
    expect(rows[0]?.familyId).toEqual(expect.any(String));
    expect(rows[1]?.familyId).toBe(rows[0]?.familyId); // one grant
    expect(rows[0]?.requestId).toMatch(UUID);
    expect(rows[1]?.requestId).not.toBe(rows[0]?.requestId); // one request each
    expect(JSON.stringify(rows)).not.toContain('Sentinel Group Name');

    const listed = await callTool(app, access, session, 'ynab_audit_log', {});
    expect(listed.body['count']).toBe(2);
    expect(listed.body['entries'][0]).toMatchObject({ client_id: clientId, outcome: 'success', request_id: rows[0]?.requestId });
  });

  it('a write YNAB applied returns its result promptly even when the audit store stalls', async () => {
    const app = await startApp({ allowWrite: true, requestTimeoutMs: 1500 });
    const { access } = await connect(app, 'read-write');
    const session = await openSession(app, access);
    // The database stops answering audit inserts.
    const append = vi.spyOn(shared.storage!, 'appendAuditEntry').mockImplementation(() => new Promise<boolean>(() => undefined));
    const started = Date.now();
    const result = await callTool(app, access, session, 'ynab_create_category_group', createGroup);
    const elapsed = Date.now() - started;
    expect(result.isError).toBe(false);
    expect(result.body['type']).not.toBe('request_timeout');
    expect(append).toHaveBeenCalledTimes(1);
    // Well inside the 1.5 s ceiling (the tool deadline is 1.35 s): the wait is half the time left, at most.
    expect(elapsed).toBeLessThan(1200);
  });

  it("records a write refused by the operator's read-only setting as denied_read_only", async () => {
    const on = await startApp({ allowWrite: true });
    const { clientId, access } = await connect(on, 'read-write');
    const off = await startApp({ allowWrite: false });
    const session = await openSession(off, access);
    const refused = await callTool(off, access, session, 'ynab_delete_transaction', {});
    expect(refused.body['type']).toBe('read_only_mode');
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await shared.storage!.listAuditEntries(USER, {}, 10);
    expect(rows).toEqual([
      expect.objectContaining({
        clientId,
        tool: 'ynab_delete_transaction',
        operation: 'delete',
        resourceType: 'transaction',
        resourceId: undefined,
        outcome: 'denied_read_only',
      }),
    ]);
  });

  it('records a write refused by a read-only grant as denied_scope', async () => {
    const app = await startApp({ allowWrite: true });
    const { clientId, access } = await connect(app, 'read-only');
    const session = await openSession(app, access);
    const refused = await callTool(app, access, session, 'ynab_create_category_group', createGroup);
    expect(refused.isError).toBe(true);
    const rows = await shared.storage!.listAuditEntries(USER, {}, 10);
    expect(rows).toEqual([expect.objectContaining({ clientId, tool: 'ynab_create_category_group', outcome: 'denied_scope' })]);
  });

  it("does not record a call that fails input validation, and erases the user's rows with the account", async () => {
    const app = await startApp();
    const { access } = await connect(app, 'read-write');
    const session = await openSession(app, access);
    const invalid = await callTool(app, access, session, 'ynab_create_category_group', { budget_id: PLAN });
    expect(invalid.isError).toBe(true);
    expect(await shared.storage!.listAuditEntries(USER, {}, 10)).toEqual([]);
    await callTool(app, access, session, 'ynab_create_category_group', createGroup);
    expect(await shared.storage!.listAuditEntries(USER, {}, 10)).toHaveLength(1);
    await shared.storage!.deleteUserData(USER);
    expect(await shared.storage!.listAuditEntries(USER, {}, 10)).toEqual([]);
  });
});

describe("ynab_audit_log shows each client its own entries (#60)", () => {
  it("client A does not see client B's rows of the same user; storage holds both", async () => {
    const app = await startApp();
    const a = await connect(app, 'read-write');
    const b = await connect(app, 'read-write');
    const sessionA = await openSession(app, a.access);
    const sessionB = await openSession(app, b.access);
    await callTool(app, a.access, sessionA, 'ynab_create_category_group', createGroup);
    await callTool(app, b.access, sessionB, 'ynab_create_category_group', createGroup);
    await callTool(app, b.access, sessionB, 'ynab_create_category_group', createGroup);

    expect(await shared.storage!.listAuditEntries(USER, {}, 10)).toHaveLength(3);
    const seenByA = (await callTool(app, a.access, sessionA, 'ynab_audit_log', {})).body;
    expect(seenByA['count']).toBe(1);
    expect(seenByA['entries'][0]['client_id']).toBe(a.clientId);
    expect(seenByA['summary']['total_operations']).toBe(1);
    const seenByB = (await callTool(app, b.access, sessionB, 'ynab_audit_log', {})).body;
    expect(seenByB['entries'].map((e: { client_id: string }) => e.client_id)).toEqual([b.clientId, b.clientId]);
  });
});

describe("ynab_rate_limit_status reports the calling client's usage (#58)", () => {
  it("shows each client its own share beside the user's total", async () => {
    const app = await startApp();
    const a = await connect(app, 'read-write');
    const b = await connect(app, 'read-write');
    const sessionA = await openSession(app, a.access);
    const sessionB = await openSession(app, b.access);
    for (let i = 0; i < 3; i++) await callTool(app, a.access, sessionA, 'ynab_create_category_group', createGroup);
    await callTool(app, b.access, sessionB, 'ynab_create_category_group', createGroup);

    const statusA = (await callTool(app, a.access, sessionA, 'ynab_rate_limit_status', {})).body;
    const statusB = (await callTool(app, b.access, sessionB, 'ynab_rate_limit_status', {})).body;
    expect(statusA['usage']['requests_last_hour']).toBe(4);
    expect(statusB['usage']['requests_last_hour']).toBe(4);
    expect(statusA['client_usage']).toEqual({ client_id: a.clientId, requests_last_hour: 3, rejected_last_hour: 0 });
    expect(statusB['client_usage']).toEqual({ client_id: b.clientId, requests_last_hour: 1, rejected_last_hour: 0 });
  });
});
