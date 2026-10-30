/**
 * Tool Titles and Annotations Tests
 */

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tools, handleToolCall } from '../../../src/tools/index.js';
import { TOOL_METADATA } from '../../../src/tools/annotations.js';
import { createServerForUser } from '../../../src/server.js';
import type { YnabClient } from '../../../src/services/ynab-client.js';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;
const WRITE_NAME = /_(create|update|delete|import|move)_/;
const DELETE_TOOLS = ['ynab_delete_scheduled_transaction', 'ynab_delete_transaction'];

describe('tool titles and annotations', () => {
  it('registers 69 tools with unique names', () => {
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(69);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a non-empty title and all four hints as booleans', () => {
    for (const tool of tools) {
      expect(tool.title, tool.name).toEqual(expect.any(String));
      expect(tool.title?.trim().length, tool.name).toBeGreaterThan(0);
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
    }
  });

  it('marks the delete and overwriting update tools as destructive, not creates or the import no-op', () => {
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();
    const expected = tools
      .map((t) => t.name)
      .filter((n) => /_(update|delete|move)_/.test(n))
      .sort();
    expect(destructive).toEqual(expected);
    for (const name of DELETE_TOOLS) expect(destructive).toContain(name);
    expect(destructive).not.toContain('ynab_import_transactions');
  });

  it('marks every create/update/delete/import tool as not read-only', () => {
    const writes = tools.filter((t) => WRITE_NAME.test(t.name));
    expect(writes.length).toBeGreaterThan(0);
    for (const tool of writes) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
    }
  });

  it('marks every other tool as read-only', () => {
    for (const tool of tools.filter((t) => !WRITE_NAME.test(t.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('treats creates as non-idempotent and updates/deletes as idempotent', () => {
    for (const tool of tools) {
      if (/_create_/.test(tool.name)) {
        expect(tool.annotations?.idempotentHint, tool.name).toBe(false);
      } else if (/_(update|delete|import)_/.test(tool.name)) {
        expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
      }
    }
  });

  it('declares every tool closed-world', () => {
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it('has exactly one table entry per registered tool', () => {
    const tableNames = Object.keys(TOOL_METADATA).sort();
    const toolNames = tools.map((t) => t.name).sort();
    expect(tableNames).toEqual(toolNames);
  });

  it('has a handler for every listed tool', async () => {
    // Unknown names throw "Unknown tool"; registered ones reach their handler,
    // which rejects the empty stub client with some other error (or succeeds).
    const stub = {} as YnabClient;
    for (const tool of tools) {
      const outcome = await handleToolCall(tool.name, {}, stub).then(
        () => 'ok',
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );
      expect(outcome, tool.name).not.toMatch(/^Unknown tool/);
    }
  });

  it('does not mutate the tool definitions exported by the tool modules', async () => {
    const { getUserTool } = await import('../../../src/tools/user/get-user.js');
    expect(getUserTool.title).toBeUndefined();
    expect(getUserTool.annotations).toBeUndefined();
  });

  it('serves titles and annotations over tools/list', async () => {
    const server = createServerForUser({
      accessToken: 'test-token',
      defaultBudgetId: undefined,
      readOnly: false,
      rateLimitPerHour: 180,
      cacheTtlMs: 300000,
    });
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(tools.length);
    const del = listed.find((t) => t.name === 'ynab_delete_transaction');
    expect(del?.title).toBe('Delete Transaction');
    expect(del?.annotations).toEqual({
      title: 'Delete Transaction',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    const list = listed.find((t) => t.name === 'ynab_list_transactions');
    expect(list?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

    await client.close();
    await server.close();
  });
});
