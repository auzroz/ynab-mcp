/**
 * An in-memory YNAB with server_knowledge, for delta-sync tests.
 *
 * Every change bumps one budget-wide knowledge counter and stamps the entity.
 * A full fetch returns the live entities; a request with last_knowledge_of_server
 * returns the entities stamped after it (deleted ones with deleted: true) and
 * the current knowledge. Filtered transaction deltas apply their filters to the
 * entity's current values, so (as may be the case on the real server) a
 * transaction that changed out of a filter is not reported by that filter's
 * delta; only the unfiltered feed sees it.
 *
 * Transaction rows carry payee_name, category_name and account_name looked up
 * when the response is built, as YNAB denormalizes them: a rename changes the
 * names a full fetch returns without stamping (or reporting) the transactions.
 *
 * `api` mirrors the ynab SDK accessors the YnabClient uses; `calls` logs every
 * request with its arguments.
 */

export const FAKE_BUDGET = 'budget-fake';

interface Versioned<T> {
  value: T;
  k: number;
  deleted: boolean;
}

export interface FakeSub {
  id: string;
  transaction_id: string;
  amount: number;
  category_id: string | null;
  payee_id: string | null;
  deleted: boolean;
}

export interface FakeTxn {
  id: string;
  date: string;
  amount: number;
  approved: boolean;
  account_id: string;
  category_id: string | null;
  payee_id: string | null;
  memo: string | null;
  deleted: boolean;
  subtransactions: FakeSub[];
}

type Row = Record<string, unknown> & { deleted: boolean };

class Table<T extends Row> {
  readonly rows = new Map<string, Versioned<T>>();
  constructor(
    private readonly tick: () => number,
    private readonly key: (t: T) => string
  ) {}

  /** Insert or update; `moveToEnd` re-inserts an existing entity last (a category moved to another group). */
  put(value: T, moveToEnd = false): void {
    const key = this.key(value);
    if (moveToEnd) this.rows.delete(key);
    this.rows.set(key, { value: { ...value, deleted: false }, k: this.tick(), deleted: false });
  }

  remove(id: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.deleted) return false;
    row.deleted = true;
    row.k = this.tick();
    return true;
  }

  get(id: string): T | undefined {
    const row = this.rows.get(id);
    return row && !row.deleted ? row.value : undefined;
  }

  live(): T[] {
    return [...this.rows.values()].filter((r) => !r.deleted).map((r) => structuredClone(r.value));
  }

  changedSince(k: number): T[] {
    return [...this.rows.values()]
      .filter((r) => r.k > k)
      .map((r) => ({ ...structuredClone(r.value), deleted: r.deleted }));
  }
}

export interface FakeQuery {
  sinceDate?: string | undefined;
  untilDate?: string | undefined;
  type?: string | undefined;
}

export class FakeYnab {
  knowledge = 1000;
  firstMonth = '2024-01-01';
  /** The server's "today" (for the default 12-month window). */
  today = '2026-06-15';
  /** Reject (400) a transaction request whose since_date is before 2000. */
  rejectFarPastSinceDate = false;
  /** Replace a delta response before it is returned (inconsistency tests). */
  tamper: ((method: string, response: { data: Record<string, unknown> }) => unknown) | undefined;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  private readonly tick = (): number => ++this.knowledge;
  readonly accounts = new Table<Row & { id: string }>(this.tick, (t) => t.id);
  readonly payees = new Table<Row & { id: string }>(this.tick, (t) => t.id);
  readonly scheduled = new Table<Row & { id: string; subtransactions: FakeSub[] }>(this.tick, (t) => t.id);
  readonly months = new Table<Row & { month: string }>(this.tick, (t) => t.month);
  readonly groups = new Table<Row & { id: string }>(this.tick, (t) => t.id);
  readonly categories = new Table<Row & { id: string; category_group_id: string }>(this.tick, (t) => t.id);
  readonly transactions = new Table<FakeTxn & Row>(this.tick, (t) => t.id);
  /** Subtransactions removed from a split, reported (deleted) in its deltas. */
  private readonly removedSubs = new Map<string, FakeSub[]>();

  // ---------- mutations ----------

  putTransaction(txn: FakeTxn): void {
    const old = this.transactions.get(txn.id);
    if (old) {
      const kept = new Set(txn.subtransactions.map((s) => s.id));
      const gone = old.subtransactions.filter((s) => !kept.has(s.id)).map((s) => ({ ...s, deleted: true }));
      if (gone.length > 0) this.removedSubs.set(txn.id, [...(this.removedSubs.get(txn.id) ?? []), ...gone]);
    }
    this.transactions.put(txn as FakeTxn & Row);
  }

  /** Insert or update a category; one that changes group goes last in its new group. */
  putCategory(cat: Row & { id: string; category_group_id: string }): void {
    const old = this.categories.get(cat.id);
    this.categories.put(cat, old !== undefined && old.category_group_id !== cat.category_group_id);
  }

  removeGroup(id: string): void {
    for (const c of this.categories.live()) if (c.category_group_id === id) this.categories.remove(c.id);
    this.groups.remove(id);
  }

  // ---------- reads ----------

  private respond<T>(method: string, args: unknown[], data: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, args });
    const response = { data: { ...data, server_knowledge: this.knowledge } };
    const lastKnowledge = args.at(-1);
    const out = lastKnowledge !== undefined && this.tamper ? this.tamper(method, response) : response;
    return Promise.resolve(structuredClone(out) as T);
  }

  /** Calls of one method, with the last_knowledge_of_server each sent. */
  knowledgeSent(method: string): Array<number | undefined> {
    return this.calls.filter((c) => c.method === method).map((c) => c.args.at(-1) as number | undefined);
  }

  private windowStart(): string {
    const d = new Date(`${this.today}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }

  private matches(t: FakeTxn, q: FakeQuery): boolean {
    const since = q.sinceDate ?? this.windowStart();
    if (t.date < since) return false;
    if (q.untilDate !== undefined && t.date > q.untilDate) return false;
    if (q.type === 'unapproved' && t.approved) return false;
    if (q.type === 'uncategorized' && (t.category_id !== null || t.subtransactions.length > 0)) return false;
    return true;
  }

  /** The names YNAB would show on a row with these ids. */
  names(ids: { account_id?: string; category_id: string | null; payee_id: string | null }): Record<string, string | null> {
    const name = (row: Row | undefined): string | null => (row === undefined ? null : (row.name as string));
    return {
      payee_name: ids.payee_id === null ? null : name(this.payees.get(ids.payee_id)),
      category_name: ids.category_id === null ? null : name(this.categories.get(ids.category_id)),
      ...(ids.account_id !== undefined ? { account_name: name(this.accounts.get(ids.account_id)) } : {}),
    };
  }

  private txnOut(t: FakeTxn & Row, deleted: boolean): FakeTxn {
    const subs = deleted ? t.subtransactions : [...t.subtransactions, ...(this.removedSubs.get(t.id) ?? [])];
    return {
      ...structuredClone(t),
      ...this.names(t),
      deleted,
      subtransactions: structuredClone(subs).map((s) => ({ ...s, ...this.names(s) })),
    };
  }

  /** Full transaction result (live, filtered, date ascending) or delta since `k`. */
  transactionList(q: FakeQuery, k: number | undefined, scope: (t: FakeTxn) => boolean = () => true): FakeTxn[] {
    const rows = [...this.transactions.rows.values()];
    const picked =
      k === undefined
        ? rows.filter((r) => !r.deleted).map((r) => this.txnOut(r.value, false)).map((t) => ({ ...t, subtransactions: t.subtransactions.filter((s) => !s.deleted) }))
        : rows.filter((r) => r.k > k).map((r) => this.txnOut(r.value, r.deleted));
    return picked
      .filter((t) => scope(t) && this.matches(t, q))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /** Category/payee rows, split lines as rows of their own (full fetches only). */
  hybridList(field: 'category_id' | 'payee_id', id: string, q: FakeQuery): Row[] {
    const rows: Row[] = [];
    for (const t of this.transactionList(q, undefined)) {
      const base = { date: t.date, approved: t.approved, account_id: t.account_id, deleted: false };
      if (t.subtransactions.length === 0) {
        if (t[field] === id) {
          rows.push({ ...base, ...this.names(t), id: t.id, amount: t.amount, category_id: t.category_id, payee_id: t.payee_id, type: 'transaction', parent_transaction_id: null });
        }
        continue;
      }
      for (const s of t.subtransactions) {
        const value = field === 'payee_id' ? (s.payee_id ?? t.payee_id) : s.category_id;
        if (value === id) {
          const ids = { account_id: t.account_id, category_id: s.category_id, payee_id: s.payee_id ?? t.payee_id };
          rows.push({ ...base, ...this.names(ids), id: s.id, amount: s.amount, category_id: s.category_id, payee_id: ids.payee_id, type: 'subtransaction', parent_transaction_id: t.id });
        }
      }
    }
    return rows;
  }

  /** Months as a full fetch returns them (newest first), without logging a call. */
  fullMonths(): Row[] {
    return this.months.live().sort((x, y) => (x.month < y.month ? 1 : x.month > y.month ? -1 : 0));
  }

  /** Category groups, full (k undefined) or as a delta; not logged. */
  categoryGroups(k: number | undefined): Row[] {
    if (k === undefined) {
      const cats = this.categories.live();
      return this.groups.live().map((g) => ({ ...g, categories: cats.filter((c) => c.category_group_id === g.id) }));
    }
    const changedCats = this.categories.changedSince(k);
    const groupIds = new Set([
      ...this.groups.changedSince(k).map((g) => g.id),
      ...changedCats.map((c) => c.category_group_id),
    ]);
    return [...this.groups.rows.values()]
      .filter((r) => groupIds.has(r.value.id))
      .map((r) => ({
        ...structuredClone(r.value),
        deleted: r.deleted,
        categories: changedCats.filter((c) => c.category_group_id === r.value.id),
      }));
  }

  private list<T extends Row>(table: Table<T>, k: number | undefined): T[] {
    return k === undefined ? table.live() : table.changedSince(k);
  }

  readonly api = {
    plans: {
      getPlans: (...args: unknown[]) =>
        this.respond('getPlans', args, { plans: [{ id: FAKE_BUDGET, name: 'Fake', first_month: this.firstMonth }] }),
      getPlanById: (...args: unknown[]) => this.respond('getPlanById', args, { plan: { id: FAKE_BUDGET } }),
    },
    accounts: {
      getAccounts: (b: string, k?: number) => this.respond('getAccounts', [b, k], { accounts: this.list(this.accounts, k) }),
      createAccount: (b: string, body: { account: Record<string, unknown> }) => {
        const account = { id: `acct-${this.knowledge + 1}`, ...body.account, deleted: false };
        this.accounts.put(account);
        return this.respond('createAccount', [b, body], { account });
      },
    },
    payees: {
      getPayees: (b: string, k?: number) => this.respond('getPayees', [b, k], { payees: this.list(this.payees, k) }),
      createPayee: (b: string, body: { payee: Record<string, unknown> }) => {
        const payee = { id: `payee-${this.knowledge + 1}`, ...body.payee, deleted: false };
        this.payees.put(payee);
        return this.respond('createPayee', [b, body], { payee });
      },
      updatePayee: (b: string, id: string, body: { payee: { name: string } }) => {
        const payee = this.payees.get(id);
        if (!payee) return Promise.reject(new Error('not found'));
        this.payees.put({ ...payee, name: body.payee.name });
        return this.respond('updatePayee', [b, id, body], { payee: this.payees.get(id) });
      },
    },
    months: {
      // Newest month first.
      getPlanMonths: (b: string, k?: number) =>
        this.respond('getPlanMonths', [b, k], {
          months: k === undefined ? this.fullMonths() : this.months.changedSince(k),
        }),
    },
    scheduledTransactions: {
      getScheduledTransactions: (b: string, k?: number) =>
        this.respond('getScheduledTransactions', [b, k], {
          scheduled_transactions:
            k === undefined
              ? this.scheduled.live()
              : this.scheduled.changedSince(k),
        }),
    },
    categories: {
      getCategories: (b: string, k?: number) =>
        this.respond('getCategories', [b, k], { category_groups: this.categoryGroups(k) }),
      updateMonthCategory: (b: string, month: string, id: string, body: { category: { budgeted: number } }) => {
        const cat = this.categories.get(id);
        if (!cat) return Promise.reject(new Error('not found'));
        this.putCategory({ ...cat, budgeted: body.category.budgeted });
        return this.respond('updateMonthCategory', [b, month, id, body], { category: this.categories.get(id) });
      },
      updateCategory: (b: string, id: string, body: { category: { name?: string } }) => {
        const cat = this.categories.get(id);
        if (!cat) return Promise.reject(new Error('not found'));
        this.putCategory({ ...cat, ...(body.category.name !== undefined ? { name: body.category.name } : {}) });
        return this.respond('updateCategory', [b, id, body], { category: this.categories.get(id) });
      },
    },
    transactions: {
      createTransaction: (b: string, body: { transaction: FakeTxn }) => {
        this.putTransaction(body.transaction);
        return this.respond('createTransaction', [b, body], { transaction: body.transaction, transaction_ids: [body.transaction.id] });
      },
      getTransactions: (b: string, sinceDate?: string, untilDate?: string, type?: string, k?: number) =>
        this.rejectFarPastSinceDate && sinceDate !== undefined && sinceDate < '2000-01-01'
          ? (this.calls.push({ method: 'getTransactions', args: [b, sinceDate, untilDate, type, k] }),
            Promise.reject({ error: { id: '400', name: 'bad_request', detail: 'invalid since_date' } }))
          : this.respond('getTransactions', [b, sinceDate, untilDate, type, k], {
          transactions: this.transactionList({ sinceDate, untilDate, type }, k),
        }),
      getTransactionsByMonth: (b: string, month: string, sinceDate?: string, untilDate?: string, type?: string, k?: number) =>
        this.respond('getTransactionsByMonth', [b, month, sinceDate, untilDate, type, k], {
          transactions: this.transactionList({ sinceDate: sinceDate ?? '0000-00-00', untilDate, type }, k, (t) =>
            t.date.startsWith(month.slice(0, 8))
          ),
        }),
      getTransactionsByAccount: (b: string, id: string, sinceDate?: string, untilDate?: string, type?: string, k?: number) =>
        this.respond('getTransactionsByAccount', [b, id, sinceDate, untilDate, type, k], {
          transactions: this.transactionList({ sinceDate, untilDate, type }, k, (t) => t.account_id === id),
        }),
      getTransactionsByCategory: (b: string, id: string, sinceDate?: string, untilDate?: string, type?: string, k?: number) =>
        this.respond('getTransactionsByCategory', [b, id, sinceDate, untilDate, type, k], {
          transactions: k === undefined ? this.hybridList('category_id', id, { sinceDate, untilDate, type }) : [],
        }),
      getTransactionsByPayee: (b: string, id: string, sinceDate?: string, untilDate?: string, type?: string, k?: number) =>
        this.respond('getTransactionsByPayee', [b, id, sinceDate, untilDate, type, k], {
          transactions: k === undefined ? this.hybridList('payee_id', id, { sinceDate, untilDate, type }) : [],
        }),
    },
  };
}
