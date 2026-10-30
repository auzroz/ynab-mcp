/**
 * tools/list filtering by read-only mode (per server / per HTTP session).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServerForUser, type UserContext } from '../../src/server.js';
import { tools } from '../../src/tools/index.js';

const baseCtx: Omit<UserContext, 'readOnly'> = {
  accessToken: 'token',
  defaultBudgetId: undefined,
  rateLimitPerHour: 180,
  cacheTtlMs: 300000,
};

const closers: Array<() => Promise<void>> = [];

async function connect(readOnly: boolean): Promise<Client> {
  const server = createServerForUser({ ...baseCtx, readOnly });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const readCount = tools.filter((t) => t.annotations?.readOnlyHint === true).length;

describe('tools/list in read-only mode', () => {
  it('returns only read tools', async () => {
    const client = await connect(true);
    const { tools: listed } = await client.listTools();
    expect(listed.length).toBe(readCount);
    expect(listed.length).toBeLessThan(tools.length);
    expect(listed.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(listed.find((t) => t.name === 'ynab_create_transaction')).toBeUndefined();
  });

  it('returns the full list in read-write mode', async () => {
    const client = await connect(false);
    const { tools: listed } = await client.listTools();
    expect(listed.length).toBe(tools.length);
    expect(listed.some((t) => t.annotations?.readOnlyHint === false)).toBe(true);
  });

  it('gives concurrent read-only and read-write sessions their own lists', async () => {
    const ro = await connect(true);
    const rw = await connect(false);
    const [roList, rwList] = await Promise.all([ro.listTools(), rw.listTools()]);
    expect(roList.tools.length).toBe(readCount);
    expect(rwList.tools.length).toBe(tools.length);
  });

  it('still rejects a hidden write tool called by name with the read-only error', async () => {
    const client = await connect(true);
    const result = await client.callTool({
      name: 'ynab_create_payee',
      arguments: { name: 'Test Payee' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.toLowerCase()).toContain('read-only');
    expect(text.toLowerCase()).not.toContain('unknown tool');
  });

  it('rejects the hidden no-op import tool by name with the read-only error', async () => {
    const client = await connect(true);
    const result = await client.callTool({ name: 'ynab_import_transactions', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).type).toBe('read_only_mode');
  });

  it('still runs the no-op import tool in read-write mode', async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: 'ynab_import_transactions', arguments: {} });
    expect(result.isError).toBeFalsy();
  });
});
