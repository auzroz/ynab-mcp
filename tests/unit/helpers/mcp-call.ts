/**
 * MCP over the HTTP app, for tests: initialize, then requests and
 * notifications, the way a 2025-era client talks to a stateless server.
 *
 * /mcp is stateless (ADR-0001): no Mcp-Session-Id is issued, each request
 * stands alone and is authorized by its own credentials, and there is nothing
 * to tear down. A "connection" here is only the client's side of it: the
 * negotiated protocol version, sent as MCP-Protocol-Version after initialize
 * as a 2025 client does, and an id counter.
 *
 * Tests that only need "call this method as this user" go through here, so a
 * transport change touches this file and the transport-specific tests, not
 * every caller.
 */

import request from 'supertest';
import type { Express } from 'express';

export const MCP_ACCEPT = 'application/json, text/event-stream';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The credential headers a request carries. */
export type McpAuth = Readonly<Record<string, string>>;

/** oauth mode: an MCP access token. */
export const bearer = (accessToken: string): McpAuth => ({ Authorization: `Bearer ${accessToken}` });

/** Header mode: a YNAB token. */
export const ynabToken = (token: string): McpAuth => ({ 'X-YNAB-Token': token });

/** No credentials. */
export const anonymous: McpAuth = {};

type Json = Record<string, any>;

/** The JSON-RPC message in a response, whether sent as JSON or as an SSE event (the last one); undefined if none. */
export function rpcMessageOrUndefined(res: request.Response): Json | undefined {
  if (res.body && typeof res.body === 'object' && 'jsonrpc' in res.body) return res.body as Json;
  const data = (res.text ?? '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .at(-1);
  return data ? (JSON.parse(data) as Json) : undefined;
}

/** Like rpcMessageOrUndefined, but throws when the response has no JSON-RPC message. */
export function rpcMessage(res: request.Response): Json {
  const message = rpcMessageOrUndefined(res);
  if (!message) throw new Error(`no JSON-RPC message in response (status ${res.status})`);
  return message;
}

/** A reply to a request: the HTTP status, the JSON-RPC message (if any) and the raw response. */
export interface McpReply {
  status: number;
  message: Json | undefined;
  res: request.Response;
}

export interface McpRequestOptions {
  /** Send this request with other credentials than the connection's. */
  auth?: McpAuth;
  /** Use this JSON-RPC id instead of the connection's next one. */
  id?: string | number;
}

export interface McpConnection {
  /** The initialize result (serverInfo, capabilities, protocolVersion). */
  readonly initializeResult: Json;
  /** A JSON-RPC request; ids are assigned per connection unless given. */
  request(method: string, params?: Json, options?: McpRequestOptions): Promise<McpReply>;
  /** A JSON-RPC notification (no id, no reply message). */
  notify(method: string, params?: Json, options?: McpRequestOptions): Promise<request.Response>;
  /** tools/list, as the tool names. */
  listTools(options?: McpRequestOptions): Promise<string[]>;
  /** tools/call, as the result's error flag and its first text block. */
  callTool(name: string, args?: Json, options?: McpRequestOptions): Promise<{ isError: boolean; text: string; reply: McpReply }>;
}

function initializeBody(clientName: string): Json {
  return {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '0.0.0' },
    },
  };
}

/** POST one JSON-RPC message to /mcp; `protocolVersion` is the MCP-Protocol-Version header a client sends after initialize. */
export function mcpPost(app: Express, auth: McpAuth, body: unknown, protocolVersion?: string): request.Test {
  let req = request(app).post('/mcp').set(auth).set('Accept', MCP_ACCEPT);
  if (protocolVersion !== undefined) req = req.set('mcp-protocol-version', protocolVersion);
  return req.send(body as object);
}

/** Send an initialize and return the raw response (for tests of a refused initialize). */
export async function mcpInitialize(app: Express, auth: McpAuth, clientName = 'mcp-call-test'): Promise<request.Response> {
  return mcpPost(app, auth, initializeBody(clientName));
}

/**
 * Initialize and acknowledge (notifications/initialized). Throws, with the
 * status, the JSON-RPC error (or the body, e.g. the bearer check's OAuth
 * error) and any WWW-Authenticate challenge, if the server refuses the
 * initialize.
 */
export async function mcpConnect(app: Express, auth: McpAuth, clientName = 'mcp-call-test'): Promise<McpConnection> {
  const init = await mcpInitialize(app, auth, clientName);
  const initMessage = rpcMessageOrUndefined(init);
  if (init.status !== 200 || !initMessage?.['result']) {
    const challenge = init.headers['www-authenticate'] as string | undefined;
    throw new Error(
      `initialize refused: ${init.status} ${JSON.stringify(initMessage?.['error'] ?? init.text)}` +
        (challenge ? ` (WWW-Authenticate: ${challenge})` : '')
    );
  }
  if (init.headers['mcp-session-id'] !== undefined) throw new Error('the server issued an Mcp-Session-Id');
  const protocolVersion = (initMessage['result'] as Json)['protocolVersion'] as string;
  let nextId = 1;

  const ack = await mcpPost(app, auth, { jsonrpc: '2.0', method: 'notifications/initialized' }, protocolVersion);
  if (ack.status !== 202) throw new Error(`notifications/initialized refused: ${ack.status}`);

  const connection: McpConnection = {
    initializeResult: initMessage['result'] as Json,

    async request(method, params = {}, options = {}) {
      const id = options.id ?? nextId++;
      const res = await mcpPost(app, options.auth ?? auth, { jsonrpc: '2.0', id, method, params }, protocolVersion);
      return { status: res.status, message: rpcMessageOrUndefined(res), res };
    },

    async notify(method, params, options = {}) {
      const body = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
      return mcpPost(app, options.auth ?? auth, body, protocolVersion);
    },

    async listTools(options) {
      const reply = await connection.request('tools/list', {}, options);
      if (reply.status !== 200 || !reply.message?.['result']) throw new Error(`tools/list failed: ${reply.status}`);
      return (reply.message['result']['tools'] as Array<{ name: string }>).map((t) => t.name);
    },

    async callTool(name, args = {}, options) {
      const reply = await connection.request('tools/call', { name, arguments: args }, options);
      const result = reply.message?.['result'] as Json | undefined;
      if (reply.status !== 200 || !result) throw new Error(`tools/call ${name} failed: ${reply.status}`);
      const text = (result['content'] as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === 'text')?.text ?? '';
      return { isError: result['isError'] === true, text, reply };
    },
  };
  return connection;
}
