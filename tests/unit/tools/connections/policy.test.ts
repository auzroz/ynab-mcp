/**
 * The account tools' policy (#53c, src/tools/connections/policy.ts), both
 * answers to the pending question, and how the tools are registered: their
 * annotations, and that they are absent wherever no account context is given
 * (stdio, header mode).
 */

import { describe, it, expect } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  ACCOUNT_CHANGES_NEED_WRITE_ACCESS,
  ACCOUNT_TOOL_NAMES,
  accountToolAllowed,
  accountToolDenial,
  type AccountToolAccess,
} from '../../../../src/tools/connections/policy.js';
import { accountTools, toolCatalog, tools } from '../../../../src/tools/index.js';
import { buildYnabClient, createServerFromClient } from '../../../../src/server.js';
import type { AccountToolContext } from '../../../../src/tools/connections/context.js';
import type { AccountStore, ConnectionRecord } from '../../../../src/storage/types.js';
import { AccountChangeNotAllowedError, formatErrorResponse } from '../../../../src/utils/errors.js';

const RW: AccountToolAccess = { grantScope: 'read-write', operatorReadOnly: false };
const RO_GRANT: AccountToolAccess = { grantScope: 'read-only', operatorReadOnly: false };
const RO_OPERATOR: AccountToolAccess = { grantScope: 'read-write', operatorReadOnly: true };
const RO_BOTH: AccountToolAccess = { grantScope: 'read-only', operatorReadOnly: true };
const CHANGES = ['ynab_revoke_connection', 'ynab_disconnect'] as const;

describe('accountToolAllowed', () => {
  it('lets every grant revoke and disconnect by default (maintainer decision, 2026-11-25)', () => {
    expect(ACCOUNT_CHANGES_NEED_WRITE_ACCESS).toBe(false);
  });

  it('allows listing on any grant, either way', () => {
    for (const need of [true, false]) {
      for (const access of [RW, RO_GRANT, RO_OPERATOR, RO_BOTH]) {
        expect(accountToolAllowed('ynab_list_connections', access, need)).toBe(true);
      }
    }
  });

  describe('restrictive reading (needWriteAccess: true, kept for a one-line flip)', () => {
    it('allows revoke and disconnect on a read-write grant with writes enabled', () => {
      for (const tool of CHANGES) expect(accountToolAllowed(tool, RW, true)).toBe(true);
    });

    it('refuses them on a read-only grant (scope) and under the operator setting (read_only, named first)', () => {
      for (const tool of CHANGES) {
        expect(accountToolDenial(tool, RO_GRANT, true)).toBe('scope');
        expect(accountToolDenial(tool, RO_OPERATOR, true)).toBe('read_only');
        expect(accountToolDenial(tool, RO_BOTH, true)).toBe('read_only');
        expect(accountToolAllowed(tool, RO_GRANT, true)).toBe(false);
      }
    });

    it('formats a refusal with its reason and no detail beyond it', () => {
      for (const reason of ['scope', 'read_only'] as const) {
        const body = JSON.parse(formatErrorResponse(new AccountChangeNotAllowedError(reason)));
        expect(body).toMatchObject({ error: true, type: 'account_change_not_allowed', reason });
      }
    });
  });

  describe('permissive: any grant may revoke and disconnect (the default)', () => {
    it('is the default', () => {
      for (const tool of ACCOUNT_TOOL_NAMES) {
        for (const access of [RW, RO_GRANT, RO_OPERATOR, RO_BOTH]) {
          expect(accountToolAllowed(tool, access), `${tool} ${JSON.stringify(access)}`).toBe(true);
        }
      }
    });

    it('allows every account tool on every grant and under the operator setting', () => {
      for (const tool of ACCOUNT_TOOL_NAMES) {
        for (const access of [RW, RO_GRANT, RO_OPERATOR, RO_BOTH]) {
          expect(accountToolDenial(tool, access, false), `${tool} ${JSON.stringify(access)}`).toBeUndefined();
        }
      }
    });
  });
});

describe('account tool registration', () => {
  it('keeps the three account tools out of the every-transport list and in the catalog', () => {
    expect(accountTools.map((t) => t.name)).toEqual([...ACCOUNT_TOOL_NAMES]);
    for (const name of ACCOUNT_TOOL_NAMES) expect(tools.map((t) => t.name)).not.toContain(name);
    expect(toolCatalog).toHaveLength(tools.length + 3);
    expect(new Set(toolCatalog.map((t) => t.name)).size).toBe(toolCatalog.length);
  });

  it('annotates listing as a read, and revoke and disconnect as destructive, idempotent, closed-world writes', () => {
    const by = new Map(accountTools.map((t) => [t.name, t]));
    expect(by.get('ynab_list_connections')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const name of CHANGES) {
      const tool = by.get(name);
      expect(tool?.title, name).toEqual(expect.any(String));
      expect(tool?.annotations, name).toMatchObject({
        title: tool?.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('describes when to use each tool', () => {
    for (const tool of accountTools) expect(tool.description, tool.name).toMatch(/Use when the user asks:\n- "/);
  });
});

/** A connected MCP client on a server built as stdio builds one, with an optional account context. */
async function connectServer(readOnly: boolean, accountContext?: AccountToolContext) {
  const server = createServerFromClient(
    buildYnabClient({ accessToken: 't', readOnly, rateLimitPerHour: 180, cacheTtlMs: 300_000 }),
    undefined,
    accountContext
  );
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
      return { isError: res.isError === true, text, structured: res.structuredContent };
    },
    async names() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** An account context on an in-memory AccountStore stub with one connection. */
function stubContext(access: AccountToolAccess, connections: ConnectionRecord[] = []) {
  const calls: string[] = [];
  const accounts: AccountStore = {
    listConnections: async () => connections,
    revokeUserFamily: async () => {
      calls.push('revoke');
      return true;
    },
    deleteTokenFamiliesForClient: async () => 0,
    deleteUserData: async () => {
      calls.push('erase');
    },
  };
  const ctx: AccountToolContext = {
    ...access,
    accounts,
    userId: 'u1',
    currentFamilyId: 'A'.repeat(43),
    afterDisconnect: async () => {
      calls.push('after');
    },
  };
  return { ctx, calls };
}

describe('the server with and without an account context', () => {
  it('stdio and header mode (no context): the tools are neither listed nor callable', async () => {
    for (const readOnly of [true, false]) {
      const s = await connectServer(readOnly);
      const names = await s.names();
      for (const name of ACCOUNT_TOOL_NAMES) {
        expect(names).not.toContain(name);
        const res = await s.call(name, name === 'ynab_disconnect' ? { confirm: 'DISCONNECT' } : { family_id: 'A'.repeat(43) });
        expect(res.isError, name).toBe(true);
        expect(res.text, name).toMatch(/Unknown tool/);
      }
      await s.close();
    }
  });

  it('a read-write grant with writes enabled lists and runs all three', async () => {
    const { ctx, calls } = stubContext(RW);
    const s = await connectServer(false, ctx);
    const names = await s.names();
    for (const name of ACCOUNT_TOOL_NAMES) expect(names).toContain(name);
    expect((await s.call('ynab_revoke_connection', { family_id: 'B'.repeat(43) })).isError).toBe(false);
    expect((await s.call('ynab_disconnect', { confirm: 'DISCONNECT' })).isError).toBe(false);
    expect(calls).toEqual(['revoke', 'erase', 'after']);
    await s.close();
  });

  it('answers with a text block only: no outputSchema, no structuredContent (until #45b gives them schemas)', async () => {
    const { ctx } = stubContext(RW);
    const s = await connectServer(false, ctx);
    const listed = (await s.client.listTools()).tools.filter((t) => (ACCOUNT_TOOL_NAMES as readonly string[]).includes(t.name));
    expect(listed).toHaveLength(3);
    for (const t of listed) expect(t.outputSchema, t.name).toBeUndefined();
    for (const [name, args] of [
      ['ynab_list_connections', {}],
      ['ynab_revoke_connection', { family_id: 'B'.repeat(43) }],
      ['ynab_disconnect', { confirm: 'DISCONNECT' }],
    ] as const) {
      const res = await s.call(name, args);
      expect(res.isError, name).toBe(false);
      expect(res.structured, name).toBeUndefined();
      expect(() => JSON.parse(res.text), name).not.toThrow();
    }
    await s.close();
  });

  it('a read-only grant, and an instance with writes off, list and run all three', async () => {
    for (const access of [RO_GRANT, RO_OPERATOR, RO_BOTH]) {
      const { ctx, calls } = stubContext(access);
      const s = await connectServer(true, ctx);
      const names = await s.names();
      for (const name of ACCOUNT_TOOL_NAMES) expect(names, JSON.stringify(access)).toContain(name);
      // The YNAB write tools stay hidden: only the account tools are exempt.
      expect(names).not.toContain('ynab_create_transaction');
      expect((await s.call('ynab_list_connections')).isError).toBe(false);
      expect((await s.call('ynab_revoke_connection', { family_id: 'B'.repeat(43) })).isError).toBe(false);
      expect((await s.call('ynab_disconnect', { confirm: 'DISCONNECT' })).isError).toBe(false);
      expect(calls).toEqual(['revoke', 'erase', 'after']);
      await s.close();
    }
  });

  it("shows a metadata-document client's host, and sanitizes the client's self-declared name", async () => {
    const base = { grantedScope: 'read-only' as const, createdAt: 0, lastUsedAt: 0, expiresAt: undefined };
    const { ctx } = stubContext(RO_GRANT, [
      { ...base, familyId: 'A'.repeat(43), clientId: 'https://app.example.org/oauth/client.json', clientName: 'Cimd\u0000 App‮' },
      { ...base, familyId: 'C'.repeat(43), clientId: 'f2d1c5b0-1111-4222-8333-944455556666', clientName: undefined },
    ]);
    const s = await connectServer(true, ctx);
    const res = await s.call('ynab_list_connections');
    const list = JSON.parse(res.text).connections as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ client_host: 'app.example.org', client_name: 'Cimd App', this_connection: true, expires_at: null });
    expect(list[1]).toMatchObject({ client_host: null, client_name: null, this_connection: false });
    await s.close();
  });
});
