/**
 * Structured tool output (#45, ADR-0001 D15): every tool's advertised
 * outputSchema, and every tool's real output validated against it.
 *
 * Real output is #44's null-payload fixture (null-output.test.ts keeps the
 * live output equal to it), plus the system tools' other shapes, which that
 * fixture's empty client never reaches. Output is checked against the closed
 * form of each schema, so a field the schema misses fails here even though
 * the advertised (open) schema would accept it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv } from 'ajv';
import type { z } from 'zod';
// The catalog: every transport's tools plus the OAuth-only account tools (#53c).
import { toolCatalog as tools, runToolCall, toolCallOutput } from '../../../src/tools/index.js';
import { closedOutputSchema, toOutputSchema } from '../../../src/tools/output-schema.js';
import { rateLimitStatusOutputSchema, handleRateLimitStatus } from '../../../src/tools/system/rate-limit-status.js';
import { auditLogOutputSchema } from '../../../src/tools/system/audit-log.js';
import { healthCheckOutputSchema, handleHealthCheck } from '../../../src/tools/system/health-check.js';
import { detectRecurringOutputSchema } from '../../../src/tools/analytics/detect-recurring.js';
import { spendingAnalysisOutputSchema } from '../../../src/tools/analytics/spending-analysis.js';
import { budgetHealthOutputSchema } from '../../../src/tools/analytics/budget-health.js';
import { savingsOpportunitiesOutputSchema } from '../../../src/tools/analytics/savings-opportunities.js';
import { budgetVsActualsOutputSchema } from '../../../src/tools/analytics/budget-vs-actuals.js';
import { quickSummaryOutputSchema } from '../../../src/tools/analytics/quick-summary.js';
import { incomeExpenseOutputSchema } from '../../../src/tools/analytics/income-expense.js';
import { netWorthOutputSchema } from '../../../src/tools/analytics/net-worth.js';
import { goalProgressOutputSchema } from '../../../src/tools/analytics/goal-progress.js';
import { spendingByPayeeOutputSchema } from '../../../src/tools/analytics/spending-by-payee.js';
import { unusedCategoriesOutputSchema } from '../../../src/tools/analytics/unused-categories.js';
import { monthlyComparisonOutputSchema } from '../../../src/tools/analytics/monthly-comparison.js';
import { spendingTrendsOutputSchema } from '../../../src/tools/analytics/spending-trends.js';
import { cashFlowForecastOutputSchema } from '../../../src/tools/analytics/cash-flow-forecast.js';
import { reconciliationHelperOutputSchema } from '../../../src/tools/analytics/reconciliation-helper.js';
import { budgetSuggestionsOutputSchema } from '../../../src/tools/analytics/budget-suggestions.js';
import { overspendingAlertsOutputSchema } from '../../../src/tools/analytics/overspending-alerts.js';
import { transactionSearchOutputSchema } from '../../../src/tools/analytics/transaction-search.js';
import { spendingPaceOutputSchema } from '../../../src/tools/analytics/spending-pace.js';
import { categoryBalancesOutputSchema } from '../../../src/tools/analytics/category-balances.js';
import { creditCardStatusOutputSchema } from '../../../src/tools/analytics/credit-card-status.js';
import { ageOfMoneyOutputSchema } from '../../../src/tools/analytics/age-of-money.js';
import { previewScheduledTransactionOutputSchema } from '../../../src/tools/analytics/preview-scheduled.js';
import { AuditLog } from '../../../src/services/audit-log.js';
import { YnabClient } from '../../../src/services/ynab-client.js';
import { RateLimiter } from '../../../src/services/rate-limiter.js';
import { Cache } from '../../../src/services/cache.js';
import { MemoryAuditStore } from '../../../src/storage/audit-rows.js';
import { createMockClient } from './fixtures/index.js';

/**
 * Tools that don't declare an outputSchema yet. This list only shrinks: the
 * test fails when a listed tool gains a schema (take it off) or an unlisted
 * tool has none. 45b (core tools) and 45c (analytics) take it to zero.
 */
const PENDING_OUTPUT_SCHEMA = [
  // User, budgets
  'ynab_get_user',
  'ynab_list_budgets',
  'ynab_get_budget',
  'ynab_get_budget_settings',
  // Accounts
  'ynab_list_accounts',
  'ynab_get_account',
  'ynab_create_account',
  // Categories
  'ynab_list_categories',
  'ynab_get_category',
  'ynab_get_month_category',
  'ynab_update_category',
  'ynab_move_money',
  'ynab_update_category_details',
  'ynab_create_category',
  'ynab_create_category_group',
  'ynab_update_category_group',
  // Payees
  'ynab_list_payees',
  'ynab_get_payee',
  'ynab_create_payee',
  'ynab_update_payee',
  'ynab_list_payee_locations',
  'ynab_get_payee_location',
  'ynab_list_payee_locations_by_payee',
  // Months
  'ynab_list_months',
  'ynab_get_month',
  // Transactions
  'ynab_list_transactions',
  'ynab_get_transaction',
  'ynab_create_transaction',
  'ynab_update_transaction',
  'ynab_delete_transaction',
  'ynab_create_transactions',
  'ynab_update_transactions',
  'ynab_list_account_transactions',
  'ynab_list_category_transactions',
  'ynab_list_payee_transactions',
  'ynab_import_transactions',
  // Scheduled transactions
  'ynab_list_scheduled_transactions',
  'ynab_get_scheduled_transaction',
  'ynab_create_scheduled_transaction',
  'ynab_update_scheduled_transaction',
  'ynab_delete_scheduled_transaction',
  // Money movements
  'ynab_list_money_movements',
  'ynab_list_money_movement_groups',
  // Analytics (45c)
  // Account tools (#53c, OAuth HTTP mode only; their own call path in server.ts)
  'ynab_list_connections',
  'ynab_revoke_connection',
  'ynab_disconnect',
];

/**
 * Each schema'd tool's Zod schema, for the closed check. A tool that gains
 * a schema adds it here (the test fails until it does).
 */
const SCHEMAS: Record<string, z.ZodObject> = {
  ynab_rate_limit_status: rateLimitStatusOutputSchema,
  ynab_audit_log: auditLogOutputSchema,
  ynab_health_check: healthCheckOutputSchema,
  ynab_detect_recurring: detectRecurringOutputSchema,
  ynab_spending_analysis: spendingAnalysisOutputSchema,
  ynab_budget_health: budgetHealthOutputSchema,
  ynab_savings_opportunities: savingsOpportunitiesOutputSchema,
  ynab_budget_vs_actuals: budgetVsActualsOutputSchema,
  ynab_quick_summary: quickSummaryOutputSchema,
  ynab_income_expense: incomeExpenseOutputSchema,
  ynab_net_worth: netWorthOutputSchema,
  ynab_goal_progress: goalProgressOutputSchema,
  ynab_spending_by_payee: spendingByPayeeOutputSchema,
  ynab_unused_categories: unusedCategoriesOutputSchema,
  ynab_monthly_comparison: monthlyComparisonOutputSchema,
  ynab_spending_trends: spendingTrendsOutputSchema,
  ynab_cash_flow_forecast: cashFlowForecastOutputSchema,
  ynab_reconciliation_helper: reconciliationHelperOutputSchema,
  ynab_budget_suggestions: budgetSuggestionsOutputSchema,
  ynab_overspending_alerts: overspendingAlertsOutputSchema,
  ynab_transaction_search: transactionSearchOutputSchema,
  ynab_spending_pace: spendingPaceOutputSchema,
  ynab_category_balances: categoryBalancesOutputSchema,
  ynab_credit_card_status: creditCardStatusOutputSchema,
  ynab_age_of_money: ageOfMoneyOutputSchema,
  ynab_preview_scheduled_transaction: previewScheduledTransactionOutputSchema,
};

const FIXTURE = fileURLToPath(new URL('./fixtures/null-output-0.4.1.json', import.meta.url));
const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { result: unknown }>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const closedValidators = new Map(Object.entries(SCHEMAS).map(([name, s]) => [name, ajv.compile(closedOutputSchema(s))]));

/** Validate `value` as it travels (JSON) against the tool's closed schema. */
function expectValid(name: string, value: unknown): void {
  const validate = closedValidators.get(name);
  expect(validate, `${name} has no entry in SCHEMAS`).toBeDefined();
  const wire = JSON.parse(JSON.stringify(value)) as unknown;
  const ok = validate!(wire);
  expect(ok, `${name}: ${ajv.errorsText(validate!.errors)}`).toBe(true);
}

/** Every key path in a JSON Schema whose value is `additionalProperties: false`. */
function closedPaths(node: unknown, path = '$'): string[] {
  if (node === null || typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && v === false) out.push(path);
    out.push(...closedPaths(v, `${path}.${k}`));
  }
  return out;
}

const schemaTools = tools.filter((t) => t.outputSchema !== undefined);

describe('output schemas: coverage', () => {
  it('lists only registered tools, once each', () => {
    const names = new Set(tools.map((t) => t.name));
    expect(PENDING_OUTPUT_SCHEMA.filter((n) => !names.has(n))).toEqual([]);
    expect(new Set(PENDING_OUTPUT_SCHEMA).size).toBe(PENDING_OUTPUT_SCHEMA.length);
  });

  it('every tool has an outputSchema or is on the pending list, never both', () => {
    const pending = new Set(PENDING_OUTPUT_SCHEMA);
    const missing = tools.filter((t) => t.outputSchema === undefined && !pending.has(t.name)).map((t) => t.name);
    const nowDone = tools.filter((t) => t.outputSchema !== undefined && pending.has(t.name)).map((t) => t.name);
    expect(missing, 'tools without an outputSchema must be on PENDING_OUTPUT_SCHEMA').toEqual([]);
    expect(nowDone, 'tools with an outputSchema must come off PENDING_OUTPUT_SCHEMA').toEqual([]);
  });

  it('every schema has its Zod source here, and the advertised schema is derived from it', () => {
    expect(schemaTools.map((t) => t.name).sort()).toEqual(Object.keys(SCHEMAS).sort());
    for (const t of schemaTools) expect(t.outputSchema, t.name).toEqual(toOutputSchema(SCHEMAS[t.name]!));
  });

  it("every schema'd tool's real output is exercised by the null-payload fixture", () => {
    for (const t of schemaTools) expect(recorded[t.name], `${t.name} is not in the null-output fixture`).toBeDefined();
  });
});

describe('output schemas: shape', () => {
  it.each(schemaTools.map((t) => [t.name, t.outputSchema!] as const))('%s: object root, open, no $schema', (_name, schema) => {
    expect(schema['type']).toBe('object');
    expect(schema).not.toHaveProperty('$schema');
    expect(closedPaths(schema)).toEqual([]);
  });

  it.each(schemaTools.map((t) => [t.name, t.outputSchema!] as const))(
    '%s: compiles as 2020-12 (the MCP default) and as draft-07 (v1 SDK clients)',
    (_name, schema) => {
      expect(() => new Ajv2020({ strict: false }).compile(schema)).not.toThrow();
      expect(() => new Ajv({ strict: false }).compile(schema)).not.toThrow();
    }
  );

  it('the closed form, which the test validates against, rejects an undeclared field the advertised one accepts', () => {
    const output = recorded['ynab_health_check']!.result as Record<string, unknown>;
    const extra = { ...output, undeclared: 1 };
    const tool = schemaTools.find((t) => t.name === 'ynab_health_check')!;
    expect(new Ajv2020({ strict: false }).validate(tool.outputSchema!, extra)).toBe(true);
    expect(closedValidators.get('ynab_health_check')!(extra)).toBe(false);
    expect(closedValidators.get('ynab_health_check')!(output)).toBe(true);
  });
});

describe('output schemas: real output validates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(schemaTools.map((t) => t.name))('%s: the null-payload fixture output', (name) => {
    expectValid(name, recorded[name]!.result);
  });

  it('ynab_rate_limit_status: every optional and nullable field present', async () => {
    const mock = createMockClient();
    mock.getRateLimitStatus.mockReturnValue({
      available: 0, limit: 180, used: 180, percentUsed: 100, canMakeRequest: false, waitTimeMs: 4000,
      resetTimeMs: 60_000, sentLastHour: 180, rejectedLastHour: 4, maxWaitMs: 2000,
      ynabExhausted: { active: true, exhaustedAtMs: 1_700_000_000_000, untilMs: 1_700_000_900_000, retryAfterMs: 900_000 },
    });
    mock.getClientUsage.mockReturnValue({ clientId: 'client-a', sentLastHour: 7, rejectedLastHour: 1 });
    mock.getUpstreamStatus.mockReturnValue({
      circuit: { state: 'open', consecutiveFailures: 20, retryAfterMs: 12_500, trips: 1 },
      cache: { bytes: 1024, maxBytes: 8_388_608 },
    });
    const out = await handleRateLimitStatus({}, mock as never);
    expect(out.ynab_exhausted).not.toBeNull();
    expect(out.upstream.retry_after_seconds).toBe(13);
    expectValid('ynab_rate_limit_status', out);
    mock.getClientUsage.mockReturnValue({ clientId: undefined, sentLastHour: 2, rejectedLastHour: 0 });
    mock.getUpstreamStatus.mockReturnValue({ circuit: { state: 'half_open', consecutiveFailures: 3, retryAfterMs: 0, trips: 1 }, cache: undefined });
    expectValid('ynab_rate_limit_status', await handleRateLimitStatus({}, mock as never));
  });

  it('ynab_health_check: unhealthy, with a failed check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mock = createMockClient();
    mock.getUser.mockRejectedValue(new Error('down'));
    const out = await handleHealthCheck({}, mock as never);
    expect(out.status).toBe('unhealthy');
    expect(out.checks.some((c) => c.error !== undefined)).toBe(true);
    expectValid('ynab_health_check', out);
  });

  it('ynab_audit_log: entries, filters and summary_only', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const audit = new AuditLog(new MemoryAuditStore(), { userId: 'u1', clientId: 'client-a', familyId: 'grant-a', requestId: 'req-1' });
    const client = new YnabClient('t', 'b', new RateLimiter(180), new Cache(300000), true, audit);
    await audit.record({ operation: 'create', tool: 'ynab_create_transaction', budgetId: 'b1', resourceType: 'transaction', resourceId: 'tx1', outcome: 'success' });
    await audit.record({ operation: 'update', tool: 'ynab_update_category', resourceType: 'category', outcome: 'denied_scope' });
    await audit.record({ operation: 'audit_suppressed', tool: 'ynab_update_category', resourceType: 'category', outcome: 'denied_scope' });
    // #60b: a bulk call's rows, and a revocation (success: null).
    await audit.recordMany({ operation: 'create', tool: 'ynab_create_transactions', budgetId: 'b1', resourceType: 'transaction', outcome: 'success' }, ['tx2', 'tx3']);
    await audit.recordRevocation({ resourceType: 'grant', resourceId: 'grant-b', outcome: 'revoked' });
    for (const args of [
      {},
      { success: false },
      { operation: 'update' },
      { operation: 'revoke', all_clients: true },
      { all_clients: true },
      { summary_only: true },
      { summary_only: true, all_clients: true },
      { summary_only: true, outcome: 'error' },
    ]) {
      const { text, structured } = await runToolCall('ynab_audit_log', args, client);
      expect(structured).toBeDefined();
      expect(text).toBe(JSON.stringify(structured, null, 2));
      expectValid('ynab_audit_log', structured);
    }
    const revoke = (await runToolCall('ynab_audit_log', { operation: 'revoke', all_clients: true }, client)).structured as {
      all_clients?: boolean;
      entries: Array<{ success: boolean | null }>;
      summary: { revocation_count: number };
    };
    expect(revoke.all_clients).toBe(true);
    expect(revoke.entries.map((e) => e.success)).toEqual([null]);
    expect(revoke.summary.revocation_count).toBe(1);
  });

  it('ynab_audit_log: a row with an operation and outcome this release does not know still validates', async () => {
    const store = new MemoryAuditStore();
    const audit = new AuditLog(store, { userId: 'u1' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await audit.record({ operation: 'from_the_future', tool: 'ynab_x', resourceType: 'thing', outcome: 'denied_future' } as never);
    const client = new YnabClient('t', 'b', new RateLimiter(180), new Cache(300000), true, audit);
    const { structured } = await runToolCall('ynab_audit_log', {}, client);
    expect((structured as { entries: Array<{ outcome: string }> }).entries[0]!.outcome).toBe('denied_future');
    expectValid('ynab_audit_log', structured);
  });
});

describe('structured output: the text block and structuredContent come from one object', () => {
  it("a schema'd tool returns both, the text being that object serialized", async () => {
    const client = new YnabClient('t', 'b', new RateLimiter(180), new Cache(300000), true, new AuditLog());
    for (const name of ['ynab_rate_limit_status', 'ynab_audit_log']) {
      const { text, structured } = await runToolCall(name, {}, client);
      expect(structured, name).toBeDefined();
      expect(text, name).toBe(JSON.stringify(structured, null, 2));
    }
  });

  it("a schema'd tool that returned text only is an error, never a result without structuredContent", () => {
    const withSchema = { name: 'x', inputSchema: { type: 'object' as const }, outputSchema: { type: 'object' as const } };
    expect(() => toolCallOutput(withSchema, '{"a":1}')).toThrow(/output schema/);
    expect(toolCallOutput(withSchema, { a: 1 })).toEqual({ text: JSON.stringify({ a: 1 }, null, 2), structured: { a: 1 } });
  });

  it('a tool without a schema keeps its text and gets no structuredContent', () => {
    const plain = { name: 'x', inputSchema: { type: 'object' as const } };
    expect(toolCallOutput(plain, '{"a":1}')).toEqual({ text: '{"a":1}' });
    expect(toolCallOutput(plain, { a: 1 })).toEqual({ text: JSON.stringify({ a: 1 }, null, 2) });
  });
});
