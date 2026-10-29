import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { handleCreateTransaction } from '../../../../src/tools/transactions/create-transaction.js';
import { handleCreateTransactions } from '../../../../src/tools/transactions/create-transactions.js';
import { handleUpdateTransaction } from '../../../../src/tools/transactions/update-transaction.js';
import { handleUpdateTransactions } from '../../../../src/tools/transactions/update-transactions.js';
import { handleGetAccount } from '../../../../src/tools/accounts/get-account.js';
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

const txn = { account_id: UUID, date: '2024-01-01', amount: -5 };

describe('free-text field caps', () => {
  const cases: Array<[string, Handler, (v: string) => Record<string, unknown>, number]> = [
    ['create_transaction.payee_name', handleCreateTransaction, (v) => ({ ...txn, payee_name: v }), 200],
    ['create_transactions.payee_name', handleCreateTransactions, (v) => ({ transactions: [{ ...txn, payee_name: v }] }), 200],
    ['update_transaction.payee_name', handleUpdateTransaction, (v) => ({ transaction_id: UUID, payee_name: v }), 200],
    ['update_transactions.payee_name', handleUpdateTransactions, (v) => ({ transactions: [{ id: UUID, payee_name: v }] }), 200],
    ['create_transactions.import_id', handleCreateTransactions, (v) => ({ transactions: [{ ...txn, import_id: v }] }), 36],
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
