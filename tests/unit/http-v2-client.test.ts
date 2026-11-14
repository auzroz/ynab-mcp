/**
 * The v2 MCP client against the real HTTP server, on both protocol eras
 * (ADR-0001 D1): 2026-07-28 on the modern leg of createMcpHandler, 2025 on its
 * stateless legacy leg. A listening server on 127.0.0.1, header mode with a
 * dummy YNAB token; YNAB's API is a stub (the client keeps the real fetch).
 *
 * Also pins the SDK's legacy-routing defect (typescript-sdk#3159, D1): when
 * the fix ships, the pinned answers change here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { buildHttpApp, type HttpApp } from '../../src/http.js';
import { SERVER_DESCRIPTION, WRITE_TIMEOUT_MESSAGE } from '../../src/server.js';
import { UNTRUSTED_TEXT_NOTE } from '../../src/tools/untrusted-note.js';
import { makeHttpConfig } from './helpers/http-config.js';
import type { HttpConfig } from '../../src/config/environment.js';

type Era = '2025-11-25' | '2026-07-28';

const READ_ONLY_TOOLS = 51;
const realFetch = globalThis.fetch;

let handle: HttpApp;
let server: HttpServer;
let base: string;
const clients: Client[] = [];

/** YNAB's API: answers ynab_get_user; while `held`, every call waits. */
const ynab = { held: false, waiting: [] as Array<() => void> };
const ynabFetch = vi.fn(async () => {
  if (ynab.held) await new Promise<void>((resolve) => ynab.waiting.push(resolve));
  return new Response(JSON.stringify({ data: { user: { id: 'u' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

async function start(overrides: Partial<HttpConfig> = {}): Promise<void> {
  handle = await buildHttpApp(makeHttpConfig({ fallbackAccessToken: undefined, ...overrides }));
  server = handle.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(era: Era, token = 'dummy-token-a'): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { 'X-YNAB-Token': token } },
    fetch: realFetch,
  });
  const client = new Client(
    { name: 'http-v2-client-test', version: '0.0.0' },
    era === '2026-07-28' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
  );
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

beforeEach(() => {
  ynab.held = false;
  vi.stubGlobal('fetch', ynabFetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  ynab.held = false;
  for (const resolve of ynab.waiting.splice(0)) resolve();
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await handle?.mcp.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each<Era>(['2025-11-25', '2026-07-28'])('the v2 client over HTTP, %s', (era) => {
  it('negotiates its era, statelessly, and gets serverInfo and the instructions', async () => {
    await start();
    const { client, transport } = await connect(era);
    expect(client.getNegotiatedProtocolVersion()).toBe(era);
    expect(client.getServerVersion()).toMatchObject({ name: 'ynab-mcp' });
    expect(client.getInstructions()).toBe(UNTRUSTED_TEXT_NOTE);
    // No session on either era.
    expect(transport.sessionId).toBeUndefined();
  });

  it('declares no change notifications: no listChanged, no resources or subscriptions (D13)', async () => {
    await start();
    const { client } = await connect(era);
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toEqual({});
    expect(caps?.prompts).toEqual({});
    expect(caps?.tools?.listChanged).toBeUndefined();
    expect(caps?.prompts?.listChanged).toBeUndefined();
    expect(caps?.resources).toBeUndefined();
  });

  it('lists the read-only tools and calls one that makes no YNAB request', async () => {
    await start();
    const { client } = await connect(era);
    const list = await client.listTools();
    expect(list.tools).toHaveLength(READ_ONLY_TOOLS);
    const result = await client.callTool({ name: 'ynab_rate_limit_status', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(ynabFetch).not.toHaveBeenCalled();
    // Each request held its slot only while it ran.
    expect(handle.inflight.inflight()).toBe(0);
  });

  it('serves two clients of two users concurrently, each as itself', async () => {
    await start();
    const [a, b] = await Promise.all([connect(era, 'dummy-token-a'), connect(era, 'dummy-token-b')]);
    const [la, lb] = await Promise.all([a.client.listTools(), b.client.listTools()]);
    expect(la.tools).toHaveLength(READ_ONLY_TOOLS);
    expect(lb.tools).toHaveLength(READ_ONLY_TOOLS);
  });
});

describe('the v2 client over HTTP, 2026-07-28 only', () => {
  it('marks tools/list private with a TTL of 0 and describes the server (D11)', async () => {
    await start();
    const { client } = await connect('2026-07-28');
    const list = (await client.listTools()) as { ttlMs?: number; cacheScope?: string };
    expect(list.cacheScope).toBe('private');
    expect(list.ttlMs).toBe(0);
    expect(client.getServerVersion()?.description).toBe(SERVER_DESCRIPTION);
  });

  it('an empty subscriptions/listen completes at once and releases its slot (D13)', async () => {
    await start();
    const { client } = await connect('2026-07-28');
    const subscription = await client.listen({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
    // The server declares no change notifications, so it honors none and ends the stream.
    expect(subscription.honoredFilter).toEqual({});
    await expect(subscription.closed).resolves.toBe('graceful');
    await expect.poll(() => handle.inflight.inflight()).toBe(0);
  });

  it('a timed-out write is an isError result with the unknown outcome over the modern leg (D6, Q8)', async () => {
    await start({ requestTimeoutMs: 500, readOnly: false });
    const { client } = await connect('2026-07-28');
    ynab.held = true;
    const result = await client.callTool({ name: 'ynab_create_category_group', arguments: { budget_id: 'last-used', name: 'G' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain(WRITE_TIMEOUT_MESSAGE);
    expect(text).toContain('"outcome": "unknown"');
  });
});

describe('SDK legacy-routing defect, typescript-sdk#3159 (pinned; ADR-0001 D1, Q6)', () => {
  // A 2025-era, non-initialize request that carries the 2026 envelope key
  // naming a 2025 revision is routed to the modern leg and refused. Plain
  // 2025 clients don't send it. No workaround (Q6): when the SDK fix (#3160)
  // ships, these become 200s and this block changes.
  const toolsList = (meta: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } });

  it('the envelope key alone: 400, -32602', async () => {
    await start();
    const res = await request(handle.app)
      .post('/mcp')
      .set('X-YNAB-Token', 'dummy-token-a')
      .set('Accept', 'application/json, text/event-stream')
      .send(toolsList({ [PROTOCOL_VERSION_META_KEY]: '2025-11-25' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });

  it('the full envelope: 400, -32022', async () => {
    await start();
    const res = await request(handle.app)
      .post('/mcp')
      .set('X-YNAB-Token', 'dummy-token-a')
      .set('Accept', 'application/json, text/event-stream')
      .send(
        toolsList({
          [PROTOCOL_VERSION_META_KEY]: '2025-11-25',
          [CLIENT_INFO_META_KEY]: { name: 'x', version: '0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        })
      );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32022);
  });

  it('without the key, the same request is served on the legacy leg', async () => {
    await start();
    const res = await request(handle.app)
      .post('/mcp')
      .set('X-YNAB-Token', 'dummy-token-a')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
  });
});
