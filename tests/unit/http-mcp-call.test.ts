/**
 * The MCP-over-HTTP test helper (tests/unit/helpers/mcp-call.ts), against the
 * real app in header mode. Nothing here calls YNAB.
 */

import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../../src/http.js';
import { makeHttpConfig } from './helpers/http-config.js';
import { anonymous, mcpConnect, mcpInitialize, rpcMessage, ynabToken } from './helpers/mcp-call.js';

describe('mcp-call helper', () => {
  it('connects, sends requests and closes without the caller handling a session id', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const mcp = await mcpConnect(app, ynabToken('token-a'));
    expect(mcp.initializeResult['serverInfo']).toBeDefined();

    const ping = await mcp.request('ping');
    expect(ping.status).toBe(200);
    expect(ping.message?.['result']).toEqual({});

    expect(await mcp.listTools()).toContain('ynab_list_budgets');

    const closed = await mcp.close();
    expect(closed?.status).toBe(200);
    expect(await mcp.close()).toBeUndefined();
  });

  it('assigns a new id to each request', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const mcp = await mcpConnect(app, ynabToken('token-a'));
    const first = await mcp.request('ping');
    const second = await mcp.request('ping');
    expect(first.message?.['id']).not.toBe(second.message?.['id']);
  });

  it('sends a single request with other credentials when asked', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const mcp = await mcpConnect(app, ynabToken('token-a'));
    // The connection belongs to token-a; another token is refused.
    expect((await mcp.request('ping', {}, { auth: ynabToken('token-b') })).status).toBe(404);
  });

  it('exposes a refused initialize and throws from connect', async () => {
    const app = await createHttpApp(makeHttpConfig());
    const res = await mcpInitialize(app, anonymous);
    expect(res.status).toBe(401);
    expect(rpcMessage(res)['error']['code']).toBe(-32001);
    await expect(mcpConnect(app, anonymous)).rejects.toThrow('initialize refused: 401');
  });
});
