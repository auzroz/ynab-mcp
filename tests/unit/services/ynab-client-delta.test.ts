/**
 * YnabClient delta sync against an in-memory YNAB (tests/unit/helpers/fake-ynab.ts):
 * - the read after a TTL expiry (or a write) sends last_knowledge_of_server and
 *   returns the merged FULL result;
 * - transaction snapshots refresh from the budget-wide change feed, so a
 *   transaction that changed out of a filtered query is not left behind;
 * - inconsistent deltas fall back to a full fetch;
 * - a read in flight across a write can't cache stale data;
 * - snapshots are shared by one user's HTTP sessions and never between users;
 * - property test: after random changes, every read equals a fresh full fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { DeltaCache } from '../../../src/services/delta-cache.js';
import { UserRegistry } from '../../../src/services/user-registry.js';
import { buildYnabClient } from '../../../src/server.js';
import { handleGetBudget } from '../../../src/tools/budgets/get-budget.js';
import { FakeYnab, FAKE_BUDGET as B, type FakeTxn } from '../helpers/fake-ynab.js';

const holder = vi.hoisted(() => ({ api: undefined as unknown }));
vi.mock('ynab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ynab')>()),
  API: vi.fn(function () {
    return holder.api;
  }),
}));

const TTL = 300_000;
const START = Date.parse('2026-06-15T00:30:00Z');

function makeClient(fake: FakeYnab, opts: { budget?: string; deltaCache?: DeltaCache; cache?: Cache } = {}): YnabClient {
  holder.api = fake.api;
  return new YnabClient(
    'token',
    opts.budget ?? B,
    new RateLimiter(1_000_000),
    opts.cache ?? new Cache(TTL),
    false,
    new AuditLog(),
    opts.deltaCache ?? new DeltaCache()
  );
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

const account = (id: string, balance = 0) => ({ id, name: id, type: 'checking', balance, closed: false, deleted: false });

function txn(id: string, date: string, extra: Partial<FakeTxn> = {}): FakeTxn {
  return {
    id,
    date,
    amount: -1000,
    approved: true,
    account_id: 'A1',
    category_id: 'c1',
    payee_id: 'P1',
    memo: null,
    deleted: false,
    subtransactions: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('request counting', () => {
  it('serves the TTL cache, then refreshes with last_knowledge_of_server after it expires', async () => {
    const fake = new FakeYnab();
    fake.accounts.put(account('a1', 100));
    fake.accounts.put(account('a2', 200));
    const client = makeClient(fake);

    const first = await client.getAccounts(B);
    const k1 = first.data.server_knowledge;
    await client.getAccounts(B); // TTL hit
    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined]);

    fake.accounts.put(account('a2', 250));
    fake.accounts.put(account('a3', 300));
    advance(TTL + 1);
    const second = await client.getAccounts(B);

    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined, k1]);
    expect(second.data.accounts).toEqual(fake.accounts.live());
    expect(second.data.server_knowledge).toBe(fake.knowledge);
    expect(client.getServerKnowledge(B, 'accounts')).toBe(fake.knowledge);
  });

  it('an unchanged budget refreshes with an empty delta and returns the same full set', async () => {
    const fake = new FakeYnab();
    fake.months.put({ month: '2026-02-01', income: 1, deleted: false });
    fake.months.put({ month: '2026-01-01', income: 2, deleted: false });
    const client = makeClient(fake);
    const first = await client.getBudgetMonths(B);
    const second = await client.getBudgetMonths(B); // months have no TTL entry
    expect(fake.knowledgeSent('getPlanMonths')).toEqual([undefined, first.data.server_knowledge]);
    expect(second.data).toEqual(first.data);
  });

  it('refreshes transactions from the change feed, not from the filtered endpoint', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2026-01-10', { account_id: 'A1' }));
    fake.putTransaction(txn('t2', '2026-01-11', { account_id: 'A2' }));
    const client = makeClient(fake);

    const first = await client.getAccountTransactions(B, 'A1', { sinceDate: '2025-01-01' });
    expect(first.data.transactions.map((t) => t.id)).toEqual(['t1']);

    // Move t1 to another account: a filtered delta for A1 wouldn't report it.
    fake.putTransaction(txn('t1', '2026-01-10', { account_id: 'A2' }));
    fake.putTransaction(txn('t3', '2026-01-12', { account_id: 'A1' }));
    const second = await client.getAccountTransactions(B, 'A1', { sinceDate: '2025-01-01' });

    expect(second.data.transactions.map((t) => t.id)).toEqual(['t3']);
    expect(fake.knowledgeSent('getTransactionsByAccount')).toEqual([undefined]);
    const feed = fake.calls.filter((c) => c.method === 'getTransactions');
    expect(feed).toEqual([{ method: 'getTransactions', args: [B, fake.firstMonth, undefined, undefined, first.data.server_knowledge] }]);
  });

  it('a hybrid (category) snapshot untouched by the feed costs one small request', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2026-01-10', { category_id: 'c1' }));
    const client = makeClient(fake);
    const first = await client.getCategoryTransactions(B, 'c1', { sinceDate: '2025-01-01' });

    fake.putTransaction(txn('t2', '2026-01-11', { category_id: 'c2', payee_id: 'P2' }));
    const second = await client.getCategoryTransactions(B, 'c1', { sinceDate: '2025-01-01' });
    expect(second.data.transactions).toEqual(first.data.transactions);
    expect(second.data.server_knowledge).toBe(fake.knowledge);
    expect(fake.knowledgeSent('getTransactionsByCategory')).toEqual([undefined]);

    // A change that concerns c1 (a split line moved into it) means a full re-read.
    fake.putTransaction(
      txn('t2', '2026-01-11', {
        category_id: null,
        subtransactions: [
          { id: 's1', transaction_id: 't2', amount: -400, category_id: 'c1', payee_id: null, deleted: false },
          { id: 's2', transaction_id: 't2', amount: -600, category_id: 'c2', payee_id: null, deleted: false },
        ],
      })
    );
    const third = await client.getCategoryTransactions(B, 'c1', { sinceDate: '2025-01-01' });
    expect(third.data.transactions.map((r) => r.id)).toEqual(['t1', 's1']);
    expect(fake.knowledgeSent('getTransactionsByCategory')).toEqual([undefined, undefined]);
  });

  it('never snapshots a budget alias (the alias can move to another budget)', async () => {
    const fake = new FakeYnab();
    fake.accounts.put(account('a1'));
    const client = makeClient(fake, { budget: 'last-used' });
    await client.getAccounts('last-used');
    advance(TTL + 1);
    await client.getAccounts('last-used');
    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined, undefined]);
  });

  it('never snapshots the "current" month', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2026-06-01'));
    const client = makeClient(fake);
    await client.getTransactionsByMonth(B, 'current');
    await client.getTransactionsByMonth(B, 'current');
    expect(fake.knowledgeSent('getTransactionsByMonth')).toEqual([undefined, undefined]);
  });

  it('ynab_get_budget never sends a cursor, even with snapshots for every list', async () => {
    const fake = new FakeYnab();
    fake.accounts.put(account('a1'));
    fake.putTransaction(txn('t1', '2026-01-10'));
    const client = makeClient(fake);
    await client.getAccounts(B);
    await client.getCategories(B);
    await client.getTransactions(B, { sinceDate: '2025-01-01' });
    await handleGetBudget({ budget_id: B }, client).catch(() => undefined);
    await client.getTransactions(B, { sinceDate: '2025-01-01' });
    await handleGetBudget({ budget_id: B }, client).catch(() => undefined);
    expect(fake.knowledgeSent('getPlanById')).toEqual([undefined, undefined]);
  });
});

describe('cursor reads (since_server_knowledge)', () => {
  it('returns YNAB delta as is and keeps the snapshot current with it', async () => {
    const fake = new FakeYnab();
    fake.accounts.put(account('a1', 1));
    fake.accounts.put(account('a2', 2));
    const client = makeClient(fake);
    const full = await client.getAccounts(B);
    const cursor = full.data.server_knowledge;

    fake.accounts.put(account('a2', 22));
    fake.accounts.remove('a1');
    const delta = await client.getAccounts(B, { lastKnowledgeOfServer: cursor });
    expect(delta.data.accounts).toEqual([
      { ...account('a1', 1), deleted: true },
      account('a2', 22),
    ]);

    // The snapshot absorbed the cursor delta: the next refresh starts after it.
    advance(TTL + 1);
    const next = await client.getAccounts(B);
    expect(next.data.accounts).toEqual([account('a2', 22)]);
    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined, cursor, delta.data.server_knowledge]);
  });

  it('passes the cursor straight through for filtered transaction queries', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2026-01-10', { approved: false }));
    const client = makeClient(fake);
    const full = await client.getTransactions(B, { type: 'unapproved', sinceDate: '2025-01-01' });
    fake.putTransaction(txn('t2', '2026-01-11', { approved: false }));
    const delta = await client.getTransactions(B, {
      type: 'unapproved',
      sinceDate: '2025-01-01',
      lastKnowledgeOfServer: full.data.server_knowledge,
    });
    expect(delta.data.transactions.map((t) => t.id)).toEqual(['t2']);
    expect(fake.calls.at(-1)?.args).toEqual([B, '2025-01-01', undefined, 'unapproved', full.data.server_knowledge]);
  });
});

describe('full-fetch fallback on inconsistency', () => {
  async function primed(): Promise<{ fake: FakeYnab; client: YnabClient }> {
    const fake = new FakeYnab();
    fake.groups.put({ id: 'g1', name: 'G1', hidden: false, deleted: false });
    fake.putCategory({ id: 'c1', category_group_id: 'g1', name: 'C1', budgeted: 1, deleted: false });
    const client = makeClient(fake);
    await client.getCategories(B);
    fake.putCategory({ id: 'c1', category_group_id: 'g1', name: 'C1', budgeted: 5, deleted: false });
    advance(TTL + 1);
    return { fake, client };
  }

  it.each([
    ['no server_knowledge', (r: { data: Record<string, unknown> }) => ({ data: { ...r.data, server_knowledge: undefined } })],
    ['knowledge going backwards', (r: { data: Record<string, unknown> }) => ({ data: { ...r.data, server_knowledge: 1 } })],
    [
      'a category in an unknown group',
      (r: { data: Record<string, unknown> }) => ({
        data: {
          ...r.data,
          category_groups: [{ id: 'gX', deleted: true, categories: [{ id: 'c1', category_group_id: 'gX', deleted: false }] }],
        },
      }),
    ],
    ['a missing list', (r: { data: Record<string, unknown> }) => ({ data: { server_knowledge: r.data.server_knowledge } })],
  ])('drops the snapshot and fetches in full on %s', async (_label, tamper) => {
    const { fake, client } = await primed();
    fake.tamper = (_method, response) => tamper(response);
    const result = await client.getCategories(B);
    expect(fake.knowledgeSent('getCategories')).toEqual([undefined, expect.any(Number), undefined]);
    expect(result.data.category_groups[0]?.categories[0]).toMatchObject({ id: 'c1', budgeted: 5 });
    expect(result.data.server_knowledge).toBe(fake.knowledge);

    // The full fetch re-based the snapshot, so deltas resume.
    fake.tamper = undefined;
    advance(TTL + 1);
    await client.getCategories(B);
    expect(fake.knowledgeSent('getCategories').at(-1)).toBe(fake.knowledge);
  });

  it('a failed delta request propagates and the next read starts over in full', async () => {
    const { fake, client } = await primed();
    const original = fake.api.categories.getCategories;
    fake.api.categories.getCategories = () => Promise.reject(new Error('boom'));
    await expect(client.getCategories(B)).rejects.toThrow('boom');
    fake.api.categories.getCategories = original;
    await client.getCategories(B);
    expect(fake.knowledgeSent('getCategories')).toEqual([undefined, undefined]);
  });

  it('a transaction snapshot holding something older than the first month is re-read in full', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2023-12-31'));
    const client = makeClient(fake);
    await client.getTransactions(B, { sinceDate: '2023-01-01' });
    await client.getTransactions(B, { sinceDate: '2023-01-01' });
    expect(fake.calls.filter((c) => c.method === 'getTransactions').map((c) => c.args[4])).toEqual([
      undefined,
      expect.any(Number), // the feed
      undefined,
    ]);
  });

  it('an uncategorized query re-reads in full when anything changed, and not otherwise', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2026-01-10', { category_id: null }));
    const client = makeClient(fake);
    const q = { type: 'uncategorized' as const, sinceDate: '2025-01-01' };
    await client.getTransactions(B, q);
    await client.getTransactions(B, q); // empty feed: snapshot as is
    fake.putTransaction(txn('t1', '2026-01-10', { category_id: 'c1' }));
    const result = await client.getTransactions(B, q);
    expect(result.data.transactions).toEqual([]);
    const sent = fake.calls.filter((c) => c.method === 'getTransactions').map((c) => [c.args[1], c.args[3], c.args[4]]);
    expect(sent).toEqual([
      ['2025-01-01', 'uncategorized', undefined],
      [fake.firstMonth, undefined, expect.any(Number)],
      [fake.firstMonth, undefined, expect.any(Number)],
      ['2025-01-01', 'uncategorized', undefined],
    ]);
  });
});

describe('writes and the generation guarantee', () => {
  it('a write makes the next read a delta refresh, not a full refetch', async () => {
    const fake = new FakeYnab();
    fake.accounts.put(account('a1'));
    const client = makeClient(fake);
    const first = await client.getAccounts(B);
    const created = await client.createAccount(B, { account: { name: 'New', type: 'checking', balance: 0 } } as never);
    const next = await client.getAccounts(B); // TTL entry dropped by the write
    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined, first.data.server_knowledge]);
    expect(next.data.accounts.map((a) => a.id)).toEqual(['a1', created.data.account.id]);
  });

  it('a category write is picked up by a delta of the nested categories', async () => {
    const fake = new FakeYnab();
    fake.groups.put({ id: 'g1', name: 'G1', hidden: false, deleted: false });
    fake.putCategory({ id: 'c1', category_group_id: 'g1', name: 'C1', budgeted: 1, deleted: false });
    fake.putCategory({ id: 'c2', category_group_id: 'g1', name: 'C2', budgeted: 2, deleted: false });
    const client = makeClient(fake);
    await client.getCategories(B);
    await client.updateMonthCategory(B, '2026-06-01', 'c2', { category: { budgeted: 99 } });
    const next = await client.getCategories(B);
    expect(fake.knowledgeSent('getCategories')).toEqual([undefined, expect.any(Number)]);
    expect(next.data.category_groups[0]?.categories.map((c) => [c.id, c.budgeted])).toEqual([
      ['c1', 1],
      ['c2', 99],
    ]);
  });

  it('a read in flight across a write does not cache its pre-write result', async () => {
    const fake = new FakeYnab();
    fake.accounts.put(account('a1'));
    const client = makeClient(fake);
    const original = fake.api.accounts.getAccounts;
    let release: (() => void) | undefined;
    fake.api.accounts.getAccounts = (b: string, k?: number) => {
      const response = original(b, k); // computed now: pre-write state
      return new Promise((resolve) => {
        release = () => resolve(response);
      });
    };

    const inflight = client.getAccounts(B);
    await vi.waitFor(() => expect(release).toBeDefined());
    fake.api.accounts.getAccounts = original;
    const created = await client.createAccount(B, { account: { name: 'New', type: 'checking' } } as never);
    release?.();
    const stale = await inflight;
    expect(stale.data.accounts.map((a) => a.id)).toEqual(['a1']);

    const next = await client.getAccounts(B);
    expect(next.data.accounts.map((a) => a.id)).toEqual(['a1', created.data.account.id]);
    // Not a TTL hit, and a delta from the in-flight read's knowledge, not a full fetch.
    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined, stale.data.server_knowledge]);
  });

  it('a read that completes while a write is in flight is dropped when the write finishes', async () => {
    const fake = new FakeYnab();
    fake.payees.put({ id: 'p1', name: 'P1', deleted: false });
    const client = makeClient(fake);
    const original = fake.api.payees.createPayee;
    let finish: (() => void) | undefined;
    fake.api.payees.createPayee = (b: string, body: { payee: Record<string, unknown> }) =>
      new Promise((resolve) => {
        finish = () => resolve(original(b, body));
      });

    const write = client.createPayee(B, { payee: { name: 'P2' } } as never);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const during = await client.getPayees(B); // before the write lands
    expect(during.data.payees.map((p) => p.id)).toEqual(['p1']);
    finish?.();
    const created = await write;

    const next = await client.getPayees(B);
    expect(next.data.payees.map((p) => p.id)).toEqual(['p1', created.data.payee.id]);
    expect(fake.knowledgeSent('getPayees')).toEqual([undefined, during.data.server_knowledge]);
  });

  it('a transaction write is picked up by the next transaction read through the feed', async () => {
    const fake = new FakeYnab();
    fake.putTransaction(txn('t1', '2026-01-10'));
    const client = makeClient(fake);
    await client.getTransactions(B, { sinceDate: '2025-01-01' });
    await client.createTransaction(B, { transaction: txn('t2', '2026-01-09') } as never);
    const next = await client.getTransactions(B, { sinceDate: '2025-01-01' });
    expect(next.data.transactions.map((t) => t.id)).toEqual(['t2', 't1']);
  });
});

describe('per-user sharing (HTTP components)', () => {
  const ctx = { accessToken: 'tok', defaultBudgetId: B, readOnly: true, rateLimitPerHour: 1_000_000, cacheTtlMs: TTL };

  it("one user's sessions share snapshots; another user's sessions never see them", async () => {
    const fake = new FakeYnab();
    holder.api = fake.api;
    fake.accounts.put(account('a1'));
    const registry = new UserRegistry({ rateLimitPerHour: 1_000_000, cacheTtlMs: TTL });
    const alice1 = registry.acquire('alice').components;
    const alice2 = registry.acquire('alice').components;
    const bob = registry.acquire('bob').components;
    expect(alice2.deltaCache).toBe(alice1.deltaCache);
    expect(bob.deltaCache).not.toBe(alice1.deltaCache);

    const first = await buildYnabClient(ctx, alice1).getAccounts(B);
    fake.accounts.put(account('a2'));
    advance(TTL + 1);
    // Alice's second session refreshes the snapshot her first session built.
    const second = await buildYnabClient(ctx, alice2).getAccounts(B);
    expect(second.data.accounts.map((a) => a.id)).toEqual(['a1', 'a2']);
    // Bob has no snapshot: a full fetch.
    await buildYnabClient(ctx, bob).getAccounts(B);
    expect(fake.knowledgeSent('getAccounts')).toEqual([undefined, first.data.server_knowledge, undefined]);
  });
});

// ---------------------------------------------------------------------------
// Property test: random changes applied to the fake server; every read through
// the client equals a fresh full fetch from it.
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChanges(fake: FakeYnab, rand: () => number, n: number, ids: { next: number }): void {
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(rand() * xs.length)]);
  const id = (prefix: string): string => `${prefix}${ids.next++}`;
  const day = (): string => {
    const start = Date.parse('2024-01-01T00:00:00Z');
    const end = Date.parse('2026-06-15T00:00:00Z');
    return new Date(start + Math.floor(rand() * ((end - start) / 86_400_000)) * 86_400_000).toISOString().slice(0, 10);
  };
  const categoryIds = ['c1', 'c2', 'c3', null];
  const payeeIds = ['P1', 'P2', null];
  const randomTxn = (txnId: string): FakeTxn => {
    const split = rand() < 0.25;
    return {
      id: txnId,
      date: day(),
      amount: -Math.floor(rand() * 100_000),
      approved: rand() < 0.6,
      account_id: pick(['A1', 'A2']) ?? 'A1',
      category_id: split ? null : (pick(categoryIds) ?? null),
      payee_id: pick(payeeIds) ?? null,
      memo: rand() < 0.5 ? 'memo' : null,
      deleted: false,
      subtransactions: split
        ? [0, 1, 2].slice(0, 2 + Math.floor(rand() * 2)).map(() => ({
            id: id('s'),
            transaction_id: txnId,
            amount: -Math.floor(rand() * 1000),
            category_id: pick(categoryIds) ?? null,
            payee_id: rand() < 0.3 ? (pick(payeeIds) ?? null) : null,
            deleted: false,
          }))
        : [],
    };
  };

  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.08) {
      fake.accounts.put(account(id('acct'), Math.floor(rand() * 1e6)));
    } else if (r < 0.13) {
      const a = pick(fake.accounts.live());
      if (a) fake.accounts.put({ ...a, balance: Math.floor(rand() * 1e6), closed: rand() < 0.2 });
    } else if (r < 0.15) {
      const a = pick(fake.accounts.live());
      if (a) fake.accounts.remove(a.id);
    } else if (r < 0.2) {
      const p = pick(fake.payees.live());
      if (p && rand() < 0.3) fake.payees.remove(p.id);
      else if (p) fake.payees.put({ ...p, name: id('name') });
      else fake.payees.put({ id: id('payee'), name: 'x', deleted: false });
    } else if (r < 0.22) {
      fake.payees.put({ id: id('payee'), name: id('n'), deleted: false });
    } else if (r < 0.25) {
      fake.groups.put({ id: id('g'), name: 'G', hidden: false, deleted: false });
    } else if (r < 0.27) {
      const g = pick(fake.groups.live());
      if (g) fake.groups.put({ ...g, name: id('G'), hidden: rand() < 0.3 });
    } else if (r < 0.28) {
      const g = pick(fake.groups.live());
      if (g) fake.removeGroup(g.id);
    } else if (r < 0.36) {
      const g = pick(fake.groups.live());
      const c = pick(fake.categories.live());
      const roll = rand();
      if (g && (roll < 0.3 || !c)) {
        fake.putCategory({ id: id('cat'), category_group_id: g.id, name: 'C', budgeted: 0, deleted: false });
      } else if (c && roll < 0.6) {
        fake.putCategory({ ...c, budgeted: Math.floor(rand() * 1e5) });
      } else if (c && g && roll < 0.85) {
        fake.putCategory({ ...c, category_group_id: g.id }); // move
      } else if (c) {
        fake.categories.remove(c.id);
      }
    } else if (r < 0.4) {
      const months = fake.months.live();
      const m = pick(months);
      if (m && rand() < 0.6) fake.months.put({ ...m, income: Math.floor(rand() * 1e5) });
      else if (m && rand() < 0.2) fake.months.remove(m.month);
      else fake.months.put({ month: `20${10 + Math.floor(rand() * 17)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-01`, income: 0, deleted: false });
    } else if (r < 0.45) {
      const s = pick(fake.scheduled.live());
      if (s && rand() < 0.25) fake.scheduled.remove(s.id);
      else {
        const sid = s?.id ?? id('sched');
        const t = randomTxn(sid);
        fake.scheduled.put({ id: sid, date_next: t.date, amount: t.amount, subtransactions: t.subtransactions, deleted: false });
      }
    } else if (r < 0.65) {
      fake.putTransaction(randomTxn(id('t')));
    } else if (r < 0.9) {
      const t = pick(fake.transactions.live());
      if (!t) continue;
      const roll = rand();
      if (roll < 0.2) fake.putTransaction({ ...t, approved: !t.approved });
      else if (roll < 0.35) fake.putTransaction({ ...t, date: day() });
      else if (roll < 0.45) fake.putTransaction({ ...t, account_id: t.account_id === 'A1' ? 'A2' : 'A1' });
      else if (roll < 0.6 && t.subtransactions.length === 0) fake.putTransaction({ ...t, category_id: pick(categoryIds) ?? null });
      else if (roll < 0.7) fake.putTransaction({ ...t, payee_id: pick(payeeIds) ?? null });
      else fake.putTransaction({ ...randomTxn(t.id), date: t.date });
    } else {
      const t = pick(fake.transactions.live());
      if (t) fake.transactions.remove(t.id);
    }
  }
}

/** Transactions in a comparable form: YNAB doesn't define the order within one date. */
function byDateThenId<T extends { date: string; id: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
}

function expectDateAscending(xs: ReadonlyArray<{ date: string }>): void {
  for (let i = 1; i < xs.length; i++) expect(xs[i - 1]!.date <= xs[i]!.date).toBe(true);
}

describe('property: merged snapshots equal a fresh full fetch', () => {
  it.each([1, 2, 3, 4, 5, 6])('seed %i', async (seed) => {
    const fake = new FakeYnab();
    const rand = rng(seed);
    const ids = { next: 1 };
    fake.groups.put({ id: 'g0', name: 'G0', hidden: false, deleted: false });
    for (const c of ['c1', 'c2', 'c3']) {
      fake.putCategory({ id: c, category_group_id: 'g0', name: c, budgeted: 0, deleted: false });
    }
    for (let m = 6; m >= 1; m--) fake.months.put({ month: `2026-0${m}-01`, income: m, deleted: false });
    randomChanges(fake, rand, 40, ids);
    const client = makeClient(fake);

    const txQueries = [
      { sinceDate: '2024-01-01' },
      {},
      { sinceDate: '2025-01-01', untilDate: '2026-03-31', type: 'unapproved' as const },
      { sinceDate: '2024-01-01', type: 'uncategorized' as const },
    ];

    for (let round = 0; round < 25; round++) {
      randomChanges(fake, rand, 1 + Math.floor(rand() * 6), ids);
      advance(6 * 60_000); // past the TTL; 25 rounds stay within one UTC day

      const accounts = await client.getAccounts(B);
      expect(accounts.data.accounts).toEqual(fake.accounts.live());
      const payees = await client.getPayees(B);
      expect(payees.data.payees).toEqual(fake.payees.live());
      const sched = await client.getScheduledTransactions(B);
      expect(sched.data.scheduled_transactions).toEqual(fake.scheduled.live());
      const months = await client.getBudgetMonths(B);
      expect(months.data.months).toEqual(fake.fullMonths());
      const categories = await client.getCategories(B);
      expect(categories.data.category_groups).toEqual(fake.categoryGroups(undefined));

      for (const q of txQueries) {
        const got = await client.getTransactions(B, q);
        expectDateAscending(got.data.transactions);
        expect(byDateThenId(got.data.transactions)).toEqual(byDateThenId(fake.transactionList(q, undefined)));
        expect(got.data.server_knowledge).toBe(fake.knowledge);
      }
      const acct = await client.getAccountTransactions(B, 'A1', { sinceDate: '2024-06-01' });
      expect(byDateThenId(acct.data.transactions)).toEqual(
        byDateThenId(fake.transactionList({ sinceDate: '2024-06-01' }, undefined, (t) => t.account_id === 'A1'))
      );
      const month = await client.getTransactionsByMonth(B, '2026-02-01');
      expect(byDateThenId(month.data.transactions)).toEqual(
        byDateThenId(fake.transactionList({ sinceDate: '0000-00-00' }, undefined, (t) => t.date.startsWith('2026-02-')))
      );
      const cat = await client.getCategoryTransactions(B, 'c1', { sinceDate: '2024-01-01' });
      expect(byDateThenId(cat.data.transactions as never)).toEqual(
        byDateThenId(fake.hybridList('category_id', 'c1', { sinceDate: '2024-01-01' }) as never)
      );
      const payee = await client.getPayeeTransactions(B, 'P1');
      expect(byDateThenId(payee.data.transactions as never)).toEqual(byDateThenId(fake.hybridList('payee_id', 'P1', {}) as never));
    }

    // Deltas did the work: after the first round, list endpoints were refreshed
    // with last_knowledge_of_server rather than re-read in full.
    for (const method of ['getAccounts', 'getPayees', 'getScheduledTransactions', 'getPlanMonths', 'getCategories']) {
      const sent = fake.knowledgeSent(method);
      expect(sent.filter((k) => k === undefined).length, method).toBeLessThanOrEqual(4); // first read + hourly re-bases
      expect(sent.filter((k) => k !== undefined).length, method).toBeGreaterThan(15);
    }
    const feedCalls = fake.calls.filter((c) => c.method === 'getTransactions' && c.args[4] !== undefined);
    expect(feedCalls.length).toBeGreaterThan(25);
    // The exact budget-wide queries were refreshed from the feed, not re-read every round.
    const fullBudgetWide = fake.calls.filter(
      (c) => c.method === 'getTransactions' && c.args[4] === undefined && c.args[1] === '2024-01-01' && c.args[3] === undefined
    );
    expect(fullBudgetWide.length).toBeLessThanOrEqual(4);
  });
});
