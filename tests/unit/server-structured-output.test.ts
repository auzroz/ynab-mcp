/**
 * Structured tool output on the wire (#45, ADR-0001 D15), with the v2 client.
 *
 * Pins what @modelcontextprotocol/client 2.4.0 does with a tool that declares
 * an outputSchema (once it has listed the tools): it rejects a non-error
 * result without structuredContent or with structuredContent that fails the
 * schema, and passes an isError result without it. The server validates
 * nothing. This is why every non-error result of a schema'd tool carries
 * structuredContent (src/tools/output-schema.ts, rule 3).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client, InMemoryTransport, ProtocolError } from '@modelcontextprotocol/client';
import { Server, type CallToolResult } from '@modelcontextprotocol/server';
import { buildYnabClient, createServerFromClient } from '../../src/server.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks();
});

async function link(server: Server): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('the v2 client and a tool with an outputSchema (pinned SDK behaviour)', () => {
  const outputSchema = { type: 'object' as const, properties: { n: { type: 'number' } }, required: ['n'] };

  async function clientFor(result: CallToolResult): Promise<Client> {
    const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' }, outputSchema }] }));
    server.setRequestHandler('tools/call', async () => server.projectCallToolResult(result, outputSchema));
    const client = await link(server);
    await client.listTools();
    return client;
  }

  const text = (t: string) => [{ type: 'text' as const, text: t }];

  it('accepts matching structuredContent', async () => {
    const client = await clientFor({ content: text('{"n":1}'), structuredContent: { n: 1 } });
    await expect(client.callTool({ name: 't', arguments: {} })).resolves.toMatchObject({ structuredContent: { n: 1 } });
  });

  it('accepts an isError result without structuredContent', async () => {
    const client = await clientFor({ content: text('{"error":true}'), isError: true });
    await expect(client.callTool({ name: 't', arguments: {} })).resolves.toMatchObject({ isError: true });
  });

  it('rejects a non-error result without structuredContent', async () => {
    const client = await clientFor({ content: text('{"n":1}') });
    const call = client.callTool({ name: 't', arguments: {} });
    await expect(call).rejects.toBeInstanceOf(ProtocolError);
    await expect(call).rejects.toThrow(/did not return structured content/);
  });

  it('rejects structuredContent that fails the schema', async () => {
    const client = await clientFor({ content: text('{"n":"x"}'), structuredContent: { n: 'x' } });
    await expect(client.callTool({ name: 't', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
  });
});

describe('our tools/call with structured output', () => {
  async function connect(): Promise<Client> {
    const ynab = buildYnabClient({ accessToken: 'token', readOnly: true, rateLimitPerHour: 180, cacheTtlMs: 300000 });
    const client = await link(createServerFromClient(ynab));
    await client.listTools();
    return client;
  }

  it.each(['ynab_rate_limit_status', 'ynab_audit_log'])('%s: structuredContent is the text block, parsed', async (name) => {
    const client = await connect();
    const result = await client.callTool({ name, arguments: {} });
    expect(result.isError).not.toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(result.content).toHaveLength(1);
    expect(block!.type).toBe('text');
    expect(result.structuredContent).toBeDefined();
    expect(block!.text).toBe(JSON.stringify(result.structuredContent, null, 2));
  });

  it("an error from a schema'd tool is isError with no structuredContent, and the client accepts it", async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'ynab_audit_log', arguments: { limit: 'many' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    // The error text is the mapped validation response, and it leaks nothing:
    // not the fixture's access token, nor the raw input value.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('many');
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(block!.text)).toMatchObject({ error: true });
  });

  it('a failed check is still a normal, structured result (ynab_health_check, YNAB unreachable)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    closers.push(async () => vi.unstubAllGlobals());
    const client = await connect();
    const result = await client.callTool({ name: 'ynab_health_check', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'unhealthy' });
  });
});
