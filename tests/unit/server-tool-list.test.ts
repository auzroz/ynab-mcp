/**
 * tools/list filtering by read-only mode (per server / per HTTP session), and
 * the serverInfo the server advertises.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildYnabClient, createServerFromClient, type UserContext } from '../../src/server.js';

/** A server on a client of its own for `ctx` (what HTTP builds per request, minus the request bounds). */
const serverFor = (ctx: UserContext) => createServerFromClient(buildYnabClient(ctx));
import { tools } from '../../src/tools/index.js';
import { UNTRUSTED_TEXT_NOTE } from '../../src/tools/untrusted-note.js';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };

const baseCtx: Omit<UserContext, 'readOnly'> = {
  accessToken: 'token',
  defaultBudgetId: undefined,
  rateLimitPerHour: 180,
  cacheTtlMs: 300000,
};

const closers: Array<() => Promise<void>> = [];

async function connect(readOnly: boolean): Promise<Client> {
  const server = serverFor({ ...baseCtx, readOnly });
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

describe('serverInfo', () => {
  it('advertises the ynab-mcp name and the package version', async () => {
    const client = await connect(true);
    expect(client.getServerVersion()).toMatchObject({ name: 'ynab-mcp', version: pkg.version });
  });

  it('sends the untrusted-text note as the server instructions', async () => {
    const client = await connect(true);
    expect(client.getInstructions()).toBe(UNTRUSTED_TEXT_NOTE);
  });
});

describe('untrusted budget text note in tool descriptions', () => {
  const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

  // Rule (#61b): every read tool whose output carries a memo or note field from
  // the budget (passed through sanitizeMemo on the way out, directly or via
  // accounts/account-fields.ts or transactions/format.ts) carries the note too.
  // Name-only tools rely on the server instructions (tested above).
  const freeTextReadTools = [
    'ynab_list_transactions',
    'ynab_get_transaction',
    'ynab_list_account_transactions',
    'ynab_list_category_transactions',
    'ynab_list_payee_transactions',
    'ynab_transaction_search',
    'ynab_list_scheduled_transactions',
    'ynab_get_scheduled_transaction',
    'ynab_reconciliation_helper',
    'ynab_get_category',
    'ynab_get_month_category',
    'ynab_list_money_movement_groups',
    'ynab_list_money_movements',
    'ynab_get_month',
    'ynab_list_months',
    'ynab_get_account',
    'ynab_list_accounts',
  ];

  const writeTools = tools.filter((t) => t.annotations?.readOnlyHint !== true);

  it('appends the note exactly once to every non-read-only tool', () => {
    expect(writeTools.length).toBeGreaterThan(0);
    for (const t of writeTools) {
      const desc = t.description ?? '';
      expect(desc.endsWith(`\n\n${UNTRUSTED_TEXT_NOTE}`), t.name).toBe(true);
      expect(countOccurrences(desc, UNTRUSTED_TEXT_NOTE), t.name).toBe(1);
    }
  });

  it('appends the note to the free-text read tools', () => {
    expect(freeTextReadTools.length).toBe(17);
    for (const name of freeTextReadTools) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description?.endsWith(`\n\n${UNTRUSTED_TEXT_NOTE}`), name).toBe(true);
    }
  });

  it('adds the note to exactly the write tools plus the free-text read tools', () => {
    const expected = new Set([...writeTools.map((t) => t.name), ...freeTextReadTools]);
    const withNote = tools.filter((t) => t.description?.includes(UNTRUSTED_TEXT_NOTE)).map((t) => t.name);
    expect(new Set(withNote)).toEqual(expected);
    expect(withNote.length).toBe(expected.size);
  });
});
