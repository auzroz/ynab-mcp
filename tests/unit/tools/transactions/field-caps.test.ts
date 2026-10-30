import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { handleCreateTransaction } from '../../../../src/tools/transactions/create-transaction.js';
import { handleCreateTransactions } from '../../../../src/tools/transactions/create-transactions.js';
import { handleUpdateTransaction } from '../../../../src/tools/transactions/update-transaction.js';
import { handleUpdateTransactions } from '../../../../src/tools/transactions/update-transactions.js';
import { handleGetAccount } from '../../../../src/tools/accounts/get-account.js';
import { handleCreateAccount } from '../../../../src/tools/accounts/create-account.js';
import { handleCreateCategory } from '../../../../src/tools/categories/create-category.js';
import { handleCreateCategoryGroup } from '../../../../src/tools/categories/create-category-group.js';
import { handleUpdateCategoryGroup } from '../../../../src/tools/categories/update-category-group.js';
import { handleCreatePayee } from '../../../../src/tools/payees/create-payee.js';
import { handleUpdatePayee } from '../../../../src/tools/payees/update-payee.js';
import { handleCreateScheduledTransaction } from '../../../../src/tools/scheduled-transactions/create-scheduled.js';
import { handleUpdateScheduledTransaction } from '../../../../src/tools/scheduled-transactions/update-scheduled.js';
import { handlePreviewScheduledTransaction } from '../../../../src/tools/analytics/preview-scheduled.js';
import { handleListTransactions } from '../../../../src/tools/transactions/list-transactions.js';
import { handleCategoryBalances } from '../../../../src/tools/analytics/category-balances.js';
import { handleTransactionSearch } from '../../../../src/tools/analytics/transaction-search.js';
import { tools } from '../../../../src/tools/index.js';
import type { YnabClient } from '../../../../src/services/ynab-client.js';

/**
 * The stub throws a sentinel from resolveBudgetId, which runs immediately after
 * zod parsing. Sentinel => schema accepted the input; ZodError => schema rejected it.
 */
const SENTINEL = 'schema-accepted';
const client = {
  resolveBudgetId: () => {
    throw new Error(SENTINEL);
  },
} as unknown as YnabClient;

const UUID = '11111111-1111-1111-1111-111111111111';
type Handler = (args: Record<string, unknown>, c: YnabClient) => Promise<string>;

async function outcome(handler: Handler, args: Record<string, unknown>) {
  try {
    await handler(args, client);
  } catch (e) {
    if (e instanceof ZodError) return 'rejected';
    if (e instanceof Error && e.message === SENTINEL) return 'accepted';
    throw e;
  }
  throw new Error('handler unexpectedly succeeded');
}

const sched = { account_id: UUID, payee_id: UUID, date: '2030-01-01', amount: -5, frequency: 'monthly' };
const txn = { account_id: UUID, date: '2024-01-01', amount: -5 };

describe('free-text field caps', () => {
  const cases: Array<[string, Handler, (v: string) => Record<string, unknown>, number]> = [
    ['create_transaction.payee_name', handleCreateTransaction, (v) => ({ ...txn, payee_name: v }), 200],
    ['create_transactions.payee_name', handleCreateTransactions, (v) => ({ transactions: [{ ...txn, payee_name: v }] }), 200],
    ['update_transaction.payee_name', handleUpdateTransaction, (v) => ({ transaction_id: UUID, payee_name: v }), 200],
    ['update_transactions.payee_name', handleUpdateTransactions, (v) => ({ transactions: [{ id: UUID, payee_name: v }] }), 200],
    ['create_transactions.import_id', handleCreateTransactions, (v) => ({ transactions: [{ ...txn, import_id: v }] }), 36],
    ['create_transaction.memo', handleCreateTransaction, (v) => ({ ...txn, memo: v }), 500],
    ['create_transactions.memo', handleCreateTransactions, (v) => ({ transactions: [{ ...txn, memo: v }] }), 500],
    ['update_transaction.memo', handleUpdateTransaction, (v) => ({ transaction_id: UUID, memo: v }), 500],
    ['update_transactions.memo', handleUpdateTransactions, (v) => ({ transactions: [{ id: UUID, memo: v }] }), 500],
    ['create_scheduled.memo', handleCreateScheduledTransaction, (v) => ({ ...sched, memo: v }), 500],
    ['update_scheduled.memo', handleUpdateScheduledTransaction, (v) => ({ scheduled_transaction_id: UUID, memo: v }), 500],
    ['create_scheduled.payee_name', handleCreateScheduledTransaction, (v) => ({ ...sched, payee_name: v }), 200],
    ['update_scheduled.payee_name', handleUpdateScheduledTransaction, (v) => ({ scheduled_transaction_id: UUID, payee_name: v }), 200],
    ['preview_scheduled.memo', handlePreviewScheduledTransaction, (v) => ({ ...sched, memo: v }), 500],
    ['preview_scheduled.payee_name', handlePreviewScheduledTransaction, (v) => ({ ...sched, payee_name: v }), 200],
    ['create_account.name', handleCreateAccount, (v) => ({ name: v, type: 'checking', balance: 0 }), 200],
    ['create_category.name', handleCreateCategory, (v) => ({ category_group_id: UUID, name: v }), 200],
    ['create_category.note', handleCreateCategory, (v) => ({ category_group_id: UUID, name: 'n', note: v }), 500],
    ['create_category_group.name', handleCreateCategoryGroup, (v) => ({ name: v }), 50],
    ['update_category_group.name', handleUpdateCategoryGroup, (v) => ({ category_group_id: UUID, name: v }), 50],
    ['create_payee.name', handleCreatePayee, (v) => ({ name: v }), 500],
    ['update_payee.name', handleUpdatePayee, (v) => ({ payee_id: UUID, name: v }), 500],
    ['list_transactions.since_date', handleListTransactions, (v) => ({ since_date: v }), 100],
    ['list_transactions.until_date', handleListTransactions, (v) => ({ until_date: v }), 100],
    ['category_balances.group', handleCategoryBalances, (v) => ({ group: v }), 200],
    ['category_balances.search', handleCategoryBalances, (v) => ({ search: v }), 200],
    ['transaction_search.payee', handleTransactionSearch, (v) => ({ payee: v }), 200],
    ['get_account.budget_id', handleGetAccount, (v) => ({ budget_id: v, account_id: UUID }), 64],
    ['create_transaction.budget_id', handleCreateTransaction, (v) => ({ ...txn, budget_id: v }), 64],
  ];

  for (const [name, handler, build, max] of cases) {
    it(`${name} accepts ${max} chars`, async () => {
      expect(await outcome(handler, build('x'.repeat(max)))).toBe('accepted');
    });
    it(`${name} rejects ${max + 1} chars`, async () => {
      expect(await outcome(handler, build('x'.repeat(max + 1)))).toBe('rejected');
    });
  }
});

describe('inputSchema maxLength parity', () => {
  /** Resolve "tool.prop" or "tool.items.prop" in the hand-written JSON Schema. */
  function jsonMax(toolName: string, prop: string): number | undefined {
    const tool = tools.find((t) => t.name === `ynab_${toolName}`);
    type S = { properties?: Record<string, S>; items?: S; maxLength?: number };
    let node = tool?.inputSchema as S | undefined;
    const props = node?.properties ?? {};
    node = props[prop] ?? props['transactions']?.items?.properties?.[prop];
    return node?.maxLength;
  }

  const parity: Array<[string, string, number]> = [
    ['create_transaction', 'memo', 500],
    ['create_transactions', 'memo', 500],
    ['update_transaction', 'memo', 500],
    ['update_transactions', 'memo', 500],
    ['create_scheduled_transaction', 'memo', 500],
    ['update_scheduled_transaction', 'memo', 500],
    ['preview_scheduled_transaction', 'memo', 500],
    ['create_transaction', 'payee_name', 200],
    ['create_transactions', 'payee_name', 200],
    ['create_transactions', 'import_id', 36],
    ['create_transaction', 'import_id', 36],
    ['update_transactions', 'import_id', 36],
    ['create_account', 'name', 200],
    ['create_category', 'name', 200],
    ['create_category', 'note', 500],
    ['create_category_group', 'name', 50],
    ['update_category_group', 'name', 50],
    ['create_payee', 'name', 500],
    ['update_payee', 'name', 500],
    ['list_transactions', 'since_date', 100],
    ['category_balances', 'search', 200],
    ['get_account', 'budget_id', 64],
  ];
  for (const [tool, prop, max] of parity) {
    it(`${tool}.${prop} declares maxLength ${max}`, () => {
      expect(jsonMax(tool, prop)).toBe(max);
    });
  }
});
