/**
 * Output parity under explicit nulls, against the real ynab SDK with fetch stubbed.
 *
 * ynab SDK 5.0 returns `null` where 4.5 left nullable fields `undefined`, which
 * would have added `"field": null` to tool output. The unit tests mock the client
 * and cannot see that, so this runs the tools through the SDK on API payloads that
 * carry explicit nulls and compares the output with the 0.4.1 output recorded on
 * ynab 4.5.0 (fixtures/null-output-0.4.1.json).
 *
 * Re-record only after a deliberate output change, with
 * NULL_OUTPUT_RECORD=1 npx vitest run tests/unit/tools/null-output.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { handleToolCall, tools } from '../../../src/tools/index.js';

const ACC = '11111111-1111-4111-8111-111111111111';
const GRP = '22222222-2222-4222-8222-222222222222';
const CAT = '33333333-3333-4333-8333-333333333333';
const PAY = '55555555-5555-4555-8555-555555555555';
const TXN = '77777777-7777-4777-8777-777777777777';
const TXN2 = '77777777-7777-4777-8777-777777777778';
const SCH = '88888888-8888-4888-8888-888888888888';
const LOC = '99999999-9999-4999-8999-999999999999';

const txnNulls = {
  id: TXN, date: '2026-10-15', amount: -12340, memo: null, cleared: 'cleared', approved: true,
  flag_color: null, flag_name: null, account_id: ACC, payee_id: null, category_id: null,
  transfer_account_id: null, transfer_transaction_id: null, matched_transaction_id: null,
  import_id: null, import_payee_name: null, import_payee_name_original: null,
  debt_transaction_type: null, deleted: false,
};
const txnFull = {
  ...txnNulls, id: TXN2, date: '2026-10-02', amount: -50000, memo: 'rent', payee_id: PAY, category_id: CAT,
};
const named = (t: Record<string, unknown>, full: boolean) => ({
  ...t, account_name: 'Checking', payee_name: full ? 'Store' : null, category_name: full ? 'Rent' : null,
  subtransactions: [],
});
const hybrid = (t: Record<string, unknown>, full: boolean) => ({
  ...named(t, full), type: 'transaction', parent_transaction_id: null,
});
const account = {
  id: ACC, name: 'Checking', type: 'checking', on_budget: true, closed: false, note: null,
  balance: 100000, cleared_balance: 100000, uncleared_balance: 0, transfer_payee_id: null,
  direct_import_linked: false, direct_import_in_error: false, last_reconciled_at: null,
  debt_original_balance: null, debt_interest_rates: null, debt_minimum_payments: null,
  debt_escrow_amounts: null, deleted: false,
};
const category = {
  id: CAT, category_group_id: GRP, category_group_name: 'Bills', name: 'Rent', hidden: false,
  original_category_group_id: null, note: null, budgeted: 50000, activity: -62340, balance: -12340,
  goal_type: null, goal_needs_whole_amount: null, goal_day: null, goal_cadence: null,
  goal_cadence_frequency: null, goal_creation_month: null, goal_target: null, goal_target_month: null,
  goal_target_date: null, goal_percentage_complete: null, goal_months_to_budget: null,
  goal_under_funded: null, goal_overall_funded: null, goal_overall_left: null, goal_snoozed_at: null,
  deleted: false,
};
const groups = [{ id: GRP, name: 'Bills', hidden: false, deleted: false, categories: [category] }];
const payee = { id: PAY, name: 'Store', transfer_account_id: null, deleted: false };
const location = { id: LOC, payee_id: PAY, latitude: '1', longitude: '2', deleted: false };
const monthSummary = {
  month: '2026-10-01', note: null, income: 0, budgeted: 50000, activity: -62340, to_be_budgeted: 0,
  age_of_money: null, deleted: false,
};
const month = { ...monthSummary, categories: [category] };
const scheduled = {
  id: SCH, date_first: '2026-10-01', date_next: '2026-11-15', frequency: 'monthly', amount: -5000,
  memo: null, flag_color: null, flag_name: null, account_id: ACC, payee_id: null, category_id: null,
  transfer_account_id: null, deleted: false, account_name: 'Checking', payee_name: null,
  category_name: null, subtransactions: [],
};
const movement = {
  id: 'mm1', month: '2026-10-01', moved_at: null, note: null, money_movement_group_id: null,
  performed_by_user_id: null, from_category_id: null, to_category_id: CAT, amount: 1000,
};
const movementGroup = { id: 'g1', group_creation_month: '2026-10-01', note: null, performed_by_user_id: null };
const summary = {
  id: 'budget-1', name: 'B', last_modified_on: null, first_month: null, last_month: null,
  date_format: null, currency_format: null, accounts: [account],
};
const budget = {
  ...summary, payees: [payee], payee_locations: [location],
  category_groups: [{ id: GRP, name: 'Bills', hidden: false, deleted: false }], categories: [category],
  months: [month], transactions: [txnNulls, txnFull], subtransactions: [],
  scheduled_transactions: [{ ...scheduled, account_name: undefined, payee_name: undefined, category_name: undefined, subtransactions: undefined }],
  scheduled_subtransactions: [],
};
const txns = [named(txnNulls, false), named(txnFull, true)];
const hybrids = [hybrid(txnNulls, false), hybrid(txnFull, true)];
const K = { server_knowledge: 10 };

function route(path: string): unknown {
  const p = path.replace(/^.*\/v1/, '');
  const rules: Array<[RegExp, unknown]> = [
    [/^\/user$/, { user: { id: 'u1' } }],
    [/^\/plans$/, { plans: [summary], default_plan: null }],
    [/^\/plans\/[^/]+\/settings$/, { settings: { date_format: null, currency_format: null } }],
    [/\/(accounts|categories|payees)\/[^/]+\/transactions$/, { transactions: hybrids, ...K }],
    [/\/months\/[^/]+\/transactions$/, { transactions: hybrids, ...K }],
    [/\/months\/[^/]+\/categories\/[^/]+$/, { category }],
    [/\/months\/[^/]+\/money_movements$/, { money_movements: [movement], ...K }],
    [/\/months\/[^/]+\/money_movement_groups$/, { money_movement_groups: [movementGroup], ...K }],
    [/\/months\/[^/]+$/, { month }],
    [/\/months$/, { months: [monthSummary], ...K }],
    [/\/money_movements$/, { money_movements: [movement], ...K }],
    [/\/money_movement_groups$/, { money_movement_groups: [movementGroup], ...K }],
    [/\/accounts\/[^/]+$/, { account }],
    [/\/accounts$/, { accounts: [account], ...K }],
    [/\/categories\/[^/]+$/, { category }],
    [/\/categories$/, { category_groups: groups, ...K }],
    [/\/payees\/[^/]+\/payee_locations$/, { payee_locations: [location] }],
    [/\/payee_locations\/[^/]+$/, { payee_location: location }],
    [/\/payee_locations$/, { payee_locations: [location] }],
    [/\/payees\/[^/]+$/, { payee }],
    [/\/payees$/, { payees: [payee], ...K }],
    [/\/scheduled_transactions\/[^/]+$/, { scheduled_transaction: scheduled }],
    [/\/scheduled_transactions$/, { scheduled_transactions: [scheduled], ...K }],
    [/\/transactions\/[^/]+$/, { transaction: txns[0], ...K }],
    [/\/transactions$/, { transactions: txns, ...K }],
    [/^\/plans\/[^/]+$/, { plan: budget, ...K }],
  ];
  for (const [re, data] of rules) if (re.test(p)) return { data };
  throw new Error(`no route for ${p}`);
}

const FILL: Record<string, unknown> = {
  account_id: ACC, category_id: CAT, payee_id: PAY, transaction_id: TXN, scheduled_transaction_id: SCH,
  payee_location_id: LOC, month: '2026-10-01', category_group_id: GRP, query: 'Store',
  statement_balance: 1000, amount: -5000, frequency: 'monthly', date: '2026-11-15',
};

/** Write tools that echo SDK fields back, with the arguments that reach the SDK. */
const WRITES: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'ynab_update_transaction', args: { transaction_id: TXN, memo: 'x' } },
  { tool: 'ynab_create_transaction', args: { account_id: ACC, date: '2026-10-15', amount: -12.34 } },
  { tool: 'ynab_create_scheduled_transaction', args: { account_id: ACC, date: '2026-11-15', amount: -50, frequency: 'monthly', payee_name: 'Store' } },
  { tool: 'ynab_update_scheduled_transaction', args: { scheduled_transaction_id: SCH, memo: 'x' } },
];

const FIXTURE = fileURLToPath(new URL('./fixtures/null-output-0.4.1.json', import.meta.url));

function writeRoute(method: string, path: string): unknown {
  const p = path.replace(/^.*\/v1/, '');
  if (method === 'POST' && /\/transactions$/.test(p)) {
    return { data: { transaction_ids: [TXN], transaction: txns[0], server_knowledge: 10 } };
  }
  if (method === 'PUT' && /\/transactions\/[^/]+$/.test(p)) return { data: { transaction: txns[0], ...K } };
  if (method === 'POST' && /\/scheduled_transactions$/.test(p)) return { data: { scheduled_transaction: scheduled } };
  if (method === 'PUT' && /\/scheduled_transactions\/[^/]+$/.test(p)) return { data: { scheduled_transaction: scheduled } };
  return route(path);
}

async function collect(): Promise<Record<string, unknown>> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) =>
    new Response(JSON.stringify(writeRoute(init?.method ?? 'GET', new URL(String(url)).pathname)), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
  const out: Record<string, unknown> = {};
  const makeClient = (readOnly: boolean) =>
    new YnabClient('token', 'budget-1', new RateLimiter(10000), new Cache(300000), readOnly, new AuditLog());
  for (const tool of tools) {
    if (!tool.annotations?.readOnlyHint) continue;
    const client = makeClient(true);
    const args: Record<string, unknown> = {};
    let result: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        result = JSON.parse(await handleToolCall(tool.name, args, client));
        break;
      } catch (e) {
        if (e instanceof ZodError) {
          const missing = e.issues.map((i) => String(i.path[0])).filter((k) => k in FILL && !(k in args));
          if (missing.length) { for (const k of missing) args[k] = FILL[k]; continue; }
        }
        result = { THREW: e instanceof Error ? e.message.slice(0, 200) : String(e) };
        break;
      }
    }
    out[tool.name] = { args, result };
  }
  for (const w of WRITES) {
    out[w.tool] = { args: w.args, result: JSON.parse(await handleToolCall(w.tool, w.args, makeClient(false))) };
  }
  return out;
}

describe('tool output under explicit API nulls (ynab SDK 5.x)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('matches the 0.4.1 output recorded on ynab 4.5.0', async () => {
    const actual = JSON.parse(JSON.stringify(await collect())) as Record<string, unknown>;
    if (process.env.NULL_OUTPUT_RECORD) {
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const name of Object.keys(expected)) expect(actual[name], name).toEqual(expected[name]);
  });

  it('never throws on the null payloads', async () => {
    const actual = JSON.stringify(await collect());
    expect(actual).not.toContain('"THREW"');
  });

  it('omits SDK nulls on the tools that pass the fields straight through', async () => {
    const out = (await collect()) as Record<string, { result: any }>;
    const txn = out['ynab_get_transaction']!.result.transaction;
    for (const k of ['payee_id', 'category_id', 'flag_color', 'transfer_account_id', 'transfer_transaction_id', 'matched_transaction_id', 'debt_transaction_type']) {
      expect(txn, k).not.toHaveProperty(k);
    }
    expect(out['ynab_list_transactions']!.result.transactions[0]).not.toHaveProperty('flag_color');
    expect(out['ynab_get_month']!.result.summary).not.toHaveProperty('age_of_money');
    expect(out['ynab_get_category']!.result.category).not.toHaveProperty('original_category_group_id');
  });
});
