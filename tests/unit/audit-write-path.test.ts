/**
 * #60a's write path, end to end through the tools/call handler: every write
 * attempt is recorded with its outcome, on every storage driver (HTTP, a
 * request's context) and in memory on stdio (D-7c); no row holds an amount,
 * a name or a memo, whatever the tool was given or YNAB answered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  createServerForRequest,
  createStdioServerFactory,
  type RequestContext,
  type UserContext,
} from '../../src/server.js';
import { AUDITED_DENIALS_PER_HOUR, createUserComponents } from '../../src/services/user-registry.js';
import { tools } from '../../src/tools/index.js';
import { WRITE_TOOL_AUDIT_TARGETS } from '../../src/tools/audit-targets.js';
import { cleanupDrivers, testDrivers, type DriverHandle } from './helpers/storage-drivers.js';

const BUDGET = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '33333333-3333-4333-8333-333333333333';
const TXN = '44444444-4444-4444-8444-444444444444';

/** Values that must never reach a row: amounts in both units, names and a memo. */
const SENTINELS = ['Sentinel', '123.45', '123450', '987.65', '987650', '4321.09', '4321090'];

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
}

async function connect(server: { connect(transport: InMemoryTransport): Promise<void> }): Promise<Client> {
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

/** A YNAB answer that echoes every sentinel back, for whatever was asked. */
function ynabEcho(): Response {
  const body = {
    data: {
      transaction: { id: TXN, amount: -123450, payee_name: 'Sentinel Payee Qx', memo: 'Sentinel Memo Qx', date: '2026-01-01', account_id: ACCOUNT, subtransactions: [] },
      transaction_ids: [TXN],
      category: { id: CATEGORY, name: 'Sentinel Category Qx', budgeted: 987650, activity: 0, balance: 987650 },
      payee: { id: 'p-1', name: 'Sentinel Payee Qx' },
      account: { id: 'a-1', name: 'Sentinel Account Qx', type: 'checking', balance: 4321090 },
      server_knowledge: 1,
    },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function ynabError(): Response {
  const body = { error: { id: '400', name: 'bad_request', detail: 'payee Sentinel Payee Qx with amount 123450 is invalid' } };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } });
}

/** The write calls the sentinel test makes, with every sentinel in their arguments. */
const SENTINEL_CALLS: Array<{ name: string; arguments: Record<string, unknown> }> = [
  {
    name: 'ynab_create_transaction',
    arguments: { budget_id: BUDGET, account_id: ACCOUNT, date: '2026-01-01', amount: -123.45, payee_name: 'Sentinel Payee Qx', memo: 'Sentinel Memo Qx' },
  },
  { name: 'ynab_update_category', arguments: { budget_id: BUDGET, month: '2026-01-01', category_id: CATEGORY, budgeted: 987.65 } },
  { name: 'ynab_create_payee', arguments: { budget_id: BUDGET, name: 'Sentinel Payee Qx' } },
  { name: 'ynab_create_account', arguments: { budget_id: BUDGET, name: 'Sentinel Account Qx', type: 'checking', balance: 4321.09 } },
];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanupDrivers();
});

/** Every stored row, every column, as the database holds it. */
async function rawRows(h: DriverHandle, userId: string): Promise<unknown[]> {
  if (h.sql) return h.sql('SELECT * FROM audit_log');
  return h.storage.listAuditEntries(userId, {}, 1000);
}

for (const driver of testDrivers) {
  describe.skipIf(!driver.enabled)(`the audit write path (#60a): ${driver.name}`, () => {
    async function requestServer(h: DriverHandle, overrides: Partial<UserContext> = {}) {
      await h.storage.upsertUser({ userId: 'u1', grantedScope: 'read-write', encryptedRefreshToken: 'enc', updatedAt: Date.now() });
      const generation = (await h.storage.getUser('u1'))?.createdAt ?? 0;
      const user: UserContext = {
        accessToken: 'tok',
        defaultBudgetId: BUDGET,
        readOnly: false,
        rateLimitPerHour: 1000,
        cacheTtlMs: 1000,
        writeLimitPerHour: 0,
        generation,
        ...overrides,
      };
      const requestId = randomUUID();
      const ctx: RequestContext = {
        requestId,
        userKey: 'u1',
        clientId: 'client-a',
        familyId: 'grant-a',
        auditStore: h.storage,
        user,
        components: createUserComponents(user),
        toolCalls: { deadline: Date.now() + 60_000, run: (work) => work() },
      };
      return { client: await connect(createServerForRequest(ctx)), requestId };
    }

    it('records each write with its caller, and no amount, name or memo, on success and on error', async () => {
      const h = await driver.open();
      vi.stubGlobal('fetch', vi.fn(async () => ynabEcho()));
      for (const call of SENTINEL_CALLS) {
        const { client, requestId } = await requestServer(h);
        const result = await client.callTool(call);
        expect(result.isError, `${call.name}: ${textOf(result)}`).toBeFalsy();
        const [row] = await h.storage.listAuditEntries('u1', {}, 1);
        expect(row).toMatchObject({
          userId: 'u1',
          clientId: 'client-a',
          familyId: 'grant-a',
          requestId,
          tool: call.name,
          ...WRITE_TOOL_AUDIT_TARGETS[call.name],
          budgetId: BUDGET,
          outcome: 'success',
        });
        await client.close();
      }
      vi.stubGlobal('fetch', vi.fn(async () => ynabError()));
      for (const call of SENTINEL_CALLS) {
        const { client } = await requestServer(h);
        expect((await client.callTool(call)).isError, call.name).toBe(true);
        await client.close();
      }

      const rows = await h.storage.listAuditEntries('u1', {}, 100);
      expect(rows.map((r) => r.outcome)).toEqual([...SENTINEL_CALLS.map(() => 'error'), ...SENTINEL_CALLS.map(() => 'success')]);
      expect(rows.find((r) => r.tool === 'ynab_create_transaction' && r.outcome === 'success')?.resourceId).toBe(TXN);
      expect(rows.find((r) => r.tool === 'ynab_update_category')?.resourceId).toBe(CATEGORY);
      const stored = JSON.stringify(await rawRows(h, 'u1'));
      for (const sentinel of SENTINELS) expect(stored, sentinel).not.toContain(sentinel);
    });

    it('records refused writes: read-only mode, a read-only grant and the write cap (first refusal only)', async () => {
      const h = await driver.open();
      const fetchSpy = vi.fn(async () => ynabEcho());
      vi.stubGlobal('fetch', fetchSpy);
      const call = SENTINEL_CALLS[0]!;

      const operator = await requestServer(h, { readOnly: true, readOnlyReason: 'read_only' });
      expect(JSON.parse(textOf(await operator.client.callTool(call)))).toMatchObject({ type: 'read_only_mode' });
      const grant = await requestServer(h, { readOnly: true, readOnlyReason: 'scope' });
      expect((await grant.client.callTool(call)).isError).toBe(true);

      // A cap of one: the second call is the episode's first refusal, the third adds no row.
      const capped = await requestServer(h, { writeLimitPerHour: 1 });
      expect(fetchSpy).not.toHaveBeenCalled(); // the refusals reached no YNAB endpoint
      expect((await capped.client.callTool(call)).isError).toBeFalsy();
      const sent = fetchSpy.mock.calls.length;
      expect(JSON.parse(textOf(await capped.client.callTool(call)))).toMatchObject({ type: 'write_limit_exceeded' });
      expect(JSON.parse(textOf(await capped.client.callTool(call)))).toMatchObject({ type: 'write_limit_exceeded' });
      expect(fetchSpy).toHaveBeenCalledTimes(sent);

      const rows = (await h.storage.listAuditEntries('u1', {}, 100)).reverse();
      expect(rows.map((r) => [r.outcome, r.requestId])).toEqual([
        ['denied_read_only', operator.requestId],
        ['denied_scope', grant.requestId],
        ['success', capped.requestId],
        ['denied_write_limit', capped.requestId],
      ]);
      for (const r of rows) expect(r).toMatchObject({ tool: 'ynab_create_transaction', operation: 'create', resourceType: 'transaction' });
      expect(rows[0]?.resourceId).toBeUndefined();
      const stored = JSON.stringify(await rawRows(h, 'u1'));
      for (const sentinel of SENTINELS) expect(stored, sentinel).not.toContain(sentinel);
    });

    it('records at most 20 read-only or scope refusals per user per hour, then one marker row, and says so once', async () => {
      const h = await driver.open();
      vi.stubGlobal('fetch', vi.fn(async () => ynabEcho()));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { client } = await requestServer(h, { readOnly: true, readOnlyReason: 'scope' });
      for (let i = 0; i < 50; i++) {
        expect(JSON.parse(textOf(await client.callTool(SENTINEL_CALLS[2]!)))).toMatchObject({ type: 'read_only_mode' });
      }
      const rows = await h.storage.listAuditEntries('u1', {}, 100);
      expect(rows).toHaveLength(AUDITED_DENIALS_PER_HOUR + 1);
      // The newest row marks where recording stopped; the refusals after it are missing.
      expect(rows[0]).toMatchObject({
        operation: 'audit_suppressed',
        outcome: 'denied_scope',
        tool: 'ynab_create_payee',
        resourceType: 'payee',
        clientId: 'client-a',
      });
      expect(rows.slice(1).every((r) => r.operation === 'create' && r.outcome === 'denied_scope')).toBe(true);
      const notices = errors.mock.calls.filter((c) => String(c[0]).includes('further ones are not recorded'));
      expect(notices).toHaveLength(1);
      // The reader of the log sees the marker.
      const listed = JSON.parse(textOf(await client.callTool({ name: 'ynab_audit_log', arguments: { operation: 'audit_suppressed' } })));
      expect(listed.count).toBe(1);
    });

    it('records a write that fails before YNAB (rate limited) once, and none for invalid input', async () => {
      const h = await driver.open();
      const fetchSpy = vi.fn(async () => ynabEcho());
      vi.stubGlobal('fetch', fetchSpy);
      const { client } = await requestServer(h, { rateLimitPerHour: 1, rateLimitMaxWaitMs: 0 });
      await client.callTool(SENTINEL_CALLS[2]!); // takes the only token
      const limited = await client.callTool(SENTINEL_CALLS[2]!);
      expect(JSON.parse(textOf(limited))).toMatchObject({ type: 'rate_limited' });
      await client.callTool({ name: 'ynab_create_payee', arguments: { budget_id: BUDGET } }); // no name: invalid
      const rows = await h.storage.listAuditEntries('u1', {}, 100);
      expect(rows.map((r) => r.outcome)).toEqual(['error', 'success']);
      expect(rows[0]).toMatchObject({ tool: 'ynab_create_payee', resourceId: undefined });
    });

    it("writes no row once the request's account has been erased", async () => {
      const h = await driver.open();
      vi.stubGlobal('fetch', vi.fn(async () => ynabEcho()));
      const { client } = await requestServer(h);
      await h.storage.deleteUserData('u1');
      await client.callTool(SENTINEL_CALLS[2]!);
      expect(await h.storage.listAuditEntries('u1', {}, 100)).toEqual([]);
    });
  });
}

describe('every write tool has an audit target (#60a)', () => {
  it('names each non-read-only tool, and no read tool', () => {
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(Object.keys(WRITE_TOOL_AUDIT_TARGETS).sort()).toEqual(writes);
  });
});

describe('the stdio audit log (memory, D-7c)', () => {
  const config = {
    accessToken: 'test-token',
    defaultBudgetId: BUDGET,
    logLevel: 'info' as const,
    cacheTtlMs: 1000,
    rateLimitPerHour: 180,
    rateLimitMaxWaitMs: 2000,
    writeLimitPerHour: 0,
  };

  it("records refused writes in read-only mode, readable from the process's other servers", async () => {
    const factory = createStdioServerFactory({ ...config, readOnly: true });
    const first = await connect(await factory({} as never));
    const second = await connect(await factory({} as never));
    expect((await first.callTool(SENTINEL_CALLS[0]!)).isError).toBe(true);
    const listed = JSON.parse(textOf(await second.callTool({ name: 'ynab_audit_log', arguments: {} })));
    expect(listed.entries).toEqual([
      expect.objectContaining({
        tool: 'ynab_create_transaction',
        outcome: 'denied_read_only',
        client_id: null,
        family_id: null,
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('Sentinel');
    await first.close();
    await second.close();
  });

  it('gives each tools/call its own request id, and reports the usage with no client id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ynabEcho()));
    const factory = createStdioServerFactory({ ...config, readOnly: false });
    const client = await connect(await factory({} as never));
    await client.callTool(SENTINEL_CALLS[2]!);
    await client.callTool(SENTINEL_CALLS[2]!);
    const listed = JSON.parse(textOf(await client.callTool({ name: 'ynab_audit_log', arguments: {} })));
    expect(listed.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['success', 'success']);
    expect(listed.entries[0].request_id).not.toBe(listed.entries[1].request_id);
    const status = JSON.parse(textOf(await client.callTool({ name: 'ynab_rate_limit_status', arguments: {} })));
    expect(status.client_usage).toEqual({ client_id: null, requests_last_hour: 2, rejected_last_hour: 0 });
    await client.close();
  });
});
