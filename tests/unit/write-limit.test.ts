/**
 * Per-user write cap (#61c, D-8).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildYnabClient, createServerFromClient, createStdioServerFactory, type UserContext } from '../../src/server.js';
import { tools } from '../../src/tools/index.js';
import { createUserComponents } from '../../src/services/user-registry.js';
import { WriteLimiter, WRITE_WINDOW_MS } from '../../src/services/write-limiter.js';
import { parseWriteLimitPerHour } from '../../src/config/write-limit.js';
import { loadConfig, loadHttpConfig } from '../../src/config/environment.js';

const WRITE_TOOLS = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
const READ_TOOLS = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);

const BUDGET = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

function userCtx(overrides: Partial<UserContext> = {}): UserContext {
  return {
    accessToken: 'test-token',
    defaultBudgetId: BUDGET,
    readOnly: false,
    rateLimitPerHour: 180,
    cacheTtlMs: 300000,
    ...overrides,
  };
}

async function connect(server: ReturnType<typeof createServerFromClient>): Promise<Client> {
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WriteLimiter', () => {
  it('admits up to the limit, then refuses until the oldest write is an hour old', () => {
    let t = 1_000_000;
    const limiter = new WriteLimiter(2, () => t);
    expect(limiter.tryAcquire()).toMatchObject({ allowed: true });
    t += 10_000;
    expect(limiter.tryAcquire()).toMatchObject({ allowed: true });
    t += 10_000;
    const refused = limiter.tryAcquire();
    expect(refused).toMatchObject({ allowed: false, limit: 2, resetsAt: 1_000_000 + WRITE_WINDOW_MS });
    t = 1_000_000 + WRITE_WINDOW_MS - 1;
    expect(limiter.tryAcquire().allowed).toBe(false);
    t = 1_000_000 + WRITE_WINDOW_MS;
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.used()).toBe(2);
  });

  it('flags only the first refusal after an admitted write', () => {
    const limiter = new WriteLimiter(1, () => 0);
    limiter.tryAcquire();
    const first = limiter.tryAcquire();
    const second = limiter.tryAcquire();
    expect(first.allowed === false && first.firstRefusal).toBe(true);
    expect(second.allowed === false && second.firstRefusal).toBe(false);
  });

  it('never refuses with a limit of 0', () => {
    const limiter = new WriteLimiter(0);
    for (let i = 0; i < 5000; i++) expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.used()).toBe(0);
  });

  it('release gives one slot back, once', () => {
    const limiter = new WriteLimiter(1, () => 0);
    const first = limiter.tryAcquire();
    if (!first.allowed) throw new Error('expected admission');
    first.release();
    first.release();
    expect(limiter.used()).toBe(0);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it('rejects a negative or fractional limit', () => {
    expect(() => new WriteLimiter(-1)).toThrow();
    expect(() => new WriteLimiter(1.5)).toThrow();
  });
});

describe('YNAB_WRITE_LIMIT_PER_HOUR parsing', () => {
  it('defaults to 20 when unset or empty', () => {
    expect(parseWriteLimitPerHour(undefined)).toBe(20);
    expect(parseWriteLimitPerHour('')).toBe(20);
  });

  it('accepts 0 and 1000 and values between', () => {
    expect(parseWriteLimitPerHour('0')).toBe(0);
    expect(parseWriteLimitPerHour('7')).toBe(7);
    expect(parseWriteLimitPerHour('1000')).toBe(1000);
  });

  it.each(['1001', '-1', '10ms', '1.5', ' 5', 'abc', '99999999999999999999'])('rejects %j without echoing it', (value) => {
    let message = '';
    try {
      parseWriteLimitPerHour(value);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/YNAB_WRITE_LIMIT_PER_HOUR/);
    expect(message).not.toContain(value.trim() === '' ? '\u0000' : value);
  });

  it('is read by the stdio config', () => {
    const saved = { ...process.env };
    try {
      process.env['YNAB_ACCESS_TOKEN'] = 'x';
      delete process.env['YNAB_WRITE_LIMIT_PER_HOUR'];
      expect(loadConfig().writeLimitPerHour).toBe(20);
      process.env['YNAB_WRITE_LIMIT_PER_HOUR'] = '0';
      expect(loadConfig().writeLimitPerHour).toBe(0);
      process.env['YNAB_WRITE_LIMIT_PER_HOUR'] = '1001';
      expect(() => loadConfig()).toThrow(/YNAB_WRITE_LIMIT_PER_HOUR/);
    } finally {
      process.env = saved;
    }
  });

  it('is read by the HTTP config, and a bad value is a listed problem', () => {
    const base = { MCP_TRANSPORT: 'http', AUTH_MODE: 'header', MCP_BIND_HOST: '127.0.0.1' };
    expect(loadHttpConfig(base).writeLimitPerHour).toBe(20);
    expect(loadHttpConfig({ ...base, YNAB_WRITE_LIMIT_PER_HOUR: '0' }).writeLimitPerHour).toBe(0);
    expect(() => loadHttpConfig({ ...base, YNAB_WRITE_LIMIT_PER_HOUR: 'ten' })).toThrow(/YNAB_WRITE_LIMIT_PER_HOUR/);
  });
});

describe('the write cap in the tools/call handler', () => {
  it('refuses every non-read-only tool once the cap is used up, with no YNAB request', async () => {
    expect(WRITE_TOOLS.length).toBeGreaterThan(10);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 1 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 1 }), components);
    ynabClient.admitWrite('ynab_create_payee'); // uses the single slot
    const client = await connect(createServerFromClient(ynabClient));

    for (const name of WRITE_TOOLS) {
      const result = await client.callTool({ name, arguments: {} });
      const body = JSON.parse(textOf(result)) as Record<string, unknown>;
      expect(result.isError, name).toBe(true);
      expect(body['type'], name).toBe('write_limit_exceeded');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ynabClient.getRateLimitStatus().available).toBe(ynabClient.getRateLimitStatus().limit);
    await client.close();
  });

  it('does not count or refuse read tools', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in unit test')));
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 1 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 1 }), components);
    ynabClient.admitWrite('ynab_create_payee');
    const client = await connect(createServerFromClient(ynabClient));
    for (const name of READ_TOOLS) {
      const result = await client.callTool({ name, arguments: {} });
      expect(textOf(result), name).not.toContain('write_limit_exceeded');
    }
    expect(components.writeLimiter.used()).toBe(1);
    await client.close();
  });

  it('names the limit and the reset time, and carries no upstream text', async () => {
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 3 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 3 }), components);
    for (let i = 0; i < 3; i++) ynabClient.admitWrite('ynab_create_payee');
    const client = await connect(createServerFromClient(ynabClient));
    const result = await client.callTool({ name: 'ynab_delete_transaction', arguments: {} });
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body).toMatchObject({ error: true, type: 'write_limit_exceeded', limit_per_hour: 3 });
    expect(String(body['message'])).toContain('3 write requests per hour');
    expect(Date.parse(String(body['resets_at']))).toBeGreaterThan(Date.now());
    expect(body['retry_after_seconds']).toBeGreaterThan(0);
    await client.close();
  });

  it('counts a bulk call as one write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { transaction_ids: ['a', 'b', 'c'], transactions: [], duplicate_import_ids: [], server_knowledge: 1 } }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 5 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 5 }), components);
    const client = await connect(createServerFromClient(ynabClient));
    const txn = (n: number) => ({ account_id: ACCOUNT, date: '2026-11-01', amount: -n });
    await client.callTool({
      name: 'ynab_create_transactions',
      arguments: { budget_id: BUDGET, transactions: [txn(1), txn(2), txn(3)] },
    });
    expect(components.writeLimiter.used()).toBe(1);
    await client.close();
  });

  it('gives the slot back for a call that fails input validation, with no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 5 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 5 }), components);
    const client = await connect(createServerFromClient(ynabClient));
    for (let i = 0; i < 8; i++) {
      const result = await client.callTool({ name: 'ynab_create_transactions', arguments: { transactions: 'nope' } });
      expect(JSON.parse(textOf(result))).toMatchObject({ type: 'validation_error' });
    }
    expect(components.writeLimiter.used()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.close();
  });

  it('keeps the slot for a call that YNAB rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { id: '400', name: 'bad_request', detail: 'no' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 5 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 5 }), components);
    const client = await connect(createServerFromClient(ynabClient));
    const result = await client.callTool({ name: 'ynab_create_payee', arguments: { budget_id: BUDGET, name: 'X' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('validation_error');
    expect(components.writeLimiter.used()).toBe(1);
    await client.close();
  });

  it('is off with a limit of 0', async () => {
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 0 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 0 }), components);
    const client = await connect(createServerFromClient(ynabClient));
    for (let i = 0; i < 30; i++) {
      const result = await client.callTool({ name: 'ynab_delete_transaction', arguments: {} });
      expect(textOf(result)).not.toContain('write_limit_exceeded');
    }
    await client.close();
  });

  it('defaults to 20 per user', async () => {
    const ynabClient = buildYnabClient(userCtx());
    for (let i = 0; i < 20; i++) await ynabClient.admitWrite('ynab_create_payee');
    await expect(ynabClient.admitWrite('ynab_create_payee')).rejects.toThrow(/Write limit/);
  });

  it('is shared by all of one user\'s clients and not by other users', async () => {
    const a = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 1 });
    const b = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 1 });
    const a1 = buildYnabClient(userCtx({ writeLimitPerHour: 1 }), a);
    const a2 = buildYnabClient(userCtx({ writeLimitPerHour: 1 }), a);
    const b1 = buildYnabClient(userCtx({ writeLimitPerHour: 1 }), b);
    await a1.admitWrite('ynab_create_payee');
    await expect(a2.admitWrite('ynab_create_payee')).rejects.toThrow(/Write limit/);
    await expect(b1.admitWrite('ynab_create_payee')).resolves.toBeTypeOf('function');
  });

  it('does not take effect in read-only mode before the read-only error', async () => {
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 1 });
    const ynabClient = buildYnabClient(userCtx({ readOnly: true, writeLimitPerHour: 1 }), components);
    const client = await connect(createServerFromClient(ynabClient));
    const result = await client.callTool({ name: 'ynab_delete_transaction', arguments: {} });
    expect(JSON.parse(textOf(result))).toMatchObject({ type: 'read_only_mode' });
    expect(components.writeLimiter.used()).toBe(0);
    await client.close();
  });

  it('applies on stdio too, from the config value', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const factory = createStdioServerFactory({
      accessToken: 'test-token',
      defaultBudgetId: BUDGET,
      logLevel: 'info',
      cacheTtlMs: 1000,
      rateLimitPerHour: 180,
      rateLimitMaxWaitMs: 2000,
      readOnly: false,
      writeLimitPerHour: 1,
    });
    // A second server from the same factory shares the one client, and so the cap.
    const first = await connect(await factory());
    const second = await connect(await factory());
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    await first.callTool({ name: 'ynab_create_payee', arguments: { budget_id: BUDGET, name: 'X' } }); // admitted, YNAB answers 500
    const refused = await second.callTool({ name: 'ynab_delete_transaction', arguments: {} });
    expect(JSON.parse(textOf(refused))).toMatchObject({ type: 'write_limit_exceeded' });
    await first.close();
    await second.close();
  });

  it('audits the first refusal of an episode once, without a payload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 1 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 1 }), components);
    ynabClient.admitWrite('ynab_create_payee');
    const client = await connect(createServerFromClient(ynabClient));
    for (let i = 0; i < 4; i++) {
      await client.callTool({ name: 'ynab_create_payee', arguments: { name: 'Secret Payee' } });
    }
    const entries = await components.auditStore.listAuditEntries('local', {}, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operation: 'create',
      resourceType: 'payee',
      tool: 'ynab_create_payee',
      outcome: 'denied_write_limit',
      resourceId: undefined,
    });
    expect(JSON.stringify(entries)).not.toContain('Secret Payee');
    await client.close();
  });
});

describe('slots and request bounds', () => {
  const payee = { budget_id: BUDGET, name: 'X' };

  async function boundedClient(bounds: { deadline: number; run: <T>(w: () => Promise<T>) => Promise<T> | undefined }) {
    const components = createUserComponents({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 5 });
    const ynabClient = buildYnabClient(userCtx({ writeLimitPerHour: 5 }), components);
    const client = await connect(createServerFromClient(ynabClient, bounds));
    return { components, client };
  }

  it('gives the slot back when the deadline has already passed (handler never starts)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { components, client } = await boundedClient({ deadline: Date.now() - 1, run: (w) => w() });
    const result = await client.callTool({ name: 'ynab_create_payee', arguments: payee });
    expect(JSON.parse(textOf(result))).toMatchObject({ type: 'request_timeout' });
    expect(components.writeLimiter.used()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.close();
  });

  it('gives the slot back when the request has ended (run returns undefined)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { components, client } = await boundedClient({ deadline: Date.now() + 60_000, run: () => undefined });
    const result = await client.callTool({ name: 'ynab_create_payee', arguments: payee });
    expect(JSON.parse(textOf(result))).toMatchObject({ type: 'request_timeout' });
    expect(components.writeLimiter.used()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.close();
  });

  it('keeps the slot for a write that started and then timed out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // YNAB never answers within the deadline.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const { components, client } = await boundedClient({ deadline: Date.now() + 300, run: (w) => w() });
    const result = await client.callTool({ name: 'ynab_create_payee', arguments: payee });
    expect(JSON.parse(textOf(result))).toMatchObject({ type: 'request_timeout', outcome: 'unknown' });
    expect(components.writeLimiter.used()).toBe(1);
    await client.close();
  });
});

describe('UserRegistry', () => {
  it('gives each user a write limiter of the configured size, kept between requests', async () => {
    const { UserRegistry } = await import('../../src/services/user-registry.js');
    const registry = new UserRegistry({ rateLimitPerHour: 180, cacheTtlMs: 1000, writeLimitPerHour: 2 });
    const first = registry.acquire('u1');
    expect(first.components.writeLimiter.limitPerHour).toBe(2);
    first.components.writeLimiter.tryAcquire();
    first.release();
    const again = registry.acquire('u1');
    expect(again.components.writeLimiter.used()).toBe(1);
    expect(registry.acquire('u2').components.writeLimiter.used()).toBe(0);
  });
});
