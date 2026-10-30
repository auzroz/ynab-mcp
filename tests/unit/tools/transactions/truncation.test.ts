/**
 * Transaction list tools report truncation: total_count (before the limit) and truncated.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleListTransactions } from '../../../../src/tools/transactions/list-transactions.js';
import { handleListAccountTransactions } from '../../../../src/tools/transactions/list-account-transactions.js';
import { handleListCategoryTransactions } from '../../../../src/tools/transactions/list-category-transactions.js';
import { handleListPayeeTransactions } from '../../../../src/tools/transactions/list-payee-transactions.js';
import {
  createMockClient,
  createTransactionsResponse,
  mockAllTransactions,
} from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

const UUID = '11111111-1111-1111-1111-111111111111';
const TOTAL = mockAllTransactions.length;

type Run = (client: MockClient, limit?: number) => Promise<{ transactions: unknown[]; summary: Record<string, unknown> }>;

const cases: [string, Run][] = [
  [
    'ynab_list_transactions',
    async (c, limit) => {
      c.getTransactions.mockResolvedValue(createTransactionsResponse());
      return JSON.parse(await handleListTransactions(limit ? { limit } : {}, c as never));
    },
  ],
  [
    'ynab_list_account_transactions',
    async (c, limit) => {
      c.getAccountTransactions.mockResolvedValue(createTransactionsResponse());
      return JSON.parse(
        await handleListAccountTransactions({ account_id: UUID, ...(limit ? { limit } : {}) }, c as never)
      );
    },
  ],
  [
    'ynab_list_category_transactions',
    async (c, limit) => {
      c.getCategoryTransactions.mockResolvedValue(createTransactionsResponse());
      return JSON.parse(
        await handleListCategoryTransactions({ category_id: UUID, ...(limit ? { limit } : {}) }, c as never)
      );
    },
  ],
  [
    'ynab_list_payee_transactions',
    async (c, limit) => {
      c.getPayeeTransactions.mockResolvedValue(createTransactionsResponse());
      return JSON.parse(
        await handleListPayeeTransactions({ payee_id: UUID, ...(limit ? { limit } : {}) }, c as never)
      );
    },
  ],
];

describe.each(cases)('%s truncation', (_name, run) => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('reports truncated with the pre-limit total when the limit cuts the list', async () => {
    const out = await run(mockClient, 2);
    expect(out.transactions).toHaveLength(2);
    expect(out.summary.count).toBe(2);
    expect(out.summary.total_count).toBe(TOTAL);
    expect(out.summary.truncated).toBe(true);
  });

  it('reports not truncated when everything fits', async () => {
    const out = await run(mockClient);
    expect(out.transactions).toHaveLength(TOTAL);
    expect(out.summary.total_count).toBe(TOTAL);
    expect(out.summary.truncated).toBe(false);
  });

  it('reports not truncated when the limit equals the number of matches', async () => {
    const out = await run(mockClient, TOTAL);
    expect(out.summary.total_count).toBe(TOTAL);
    expect(out.summary.truncated).toBe(false);
  });
});
