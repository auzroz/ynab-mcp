/**
 * Import Transactions Tool Tests (deprecated tool)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleImportTransactions,
  importTransactionsTool,
  IMPORT_DEPRECATION_MESSAGE,
} from '../../../../src/tools/transactions/import-transactions.js';
import { createMockClient } from '../fixtures/index.js';
import type { MockClient } from '../fixtures/index.js';

describe('importTransactionsTool definition', () => {
  it('description starts with DEPRECATED:', () => {
    expect(importTransactionsTool.description?.startsWith('DEPRECATED:')).toBe(true);
  });

  it('does not contain sync-style trigger phrases', () => {
    const description = importTransactionsTool.description ?? '';
    expect(description).not.toContain('Import my bank transactions');
    expect(description).not.toContain('Sync my accounts');
    expect(description).not.toContain('Refresh bank connections');
    expect(description).toContain('Do NOT use this tool to sync');
  });
});

describe('handleImportTransactions', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('returns the deprecation response without calling the API', async () => {
    // A client exposing only budget resolution proves the handler makes no API call
    const apiFreeClient = { resolveBudgetId: () => 'test-budget-id' };
    const result = await handleImportTransactions({}, apiFreeClient as never);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.deprecated).toBe(true);
    expect(parsed.message).toBe(IMPORT_DEPRECATION_MESSAGE);
    expect(parsed.message).toContain('linked-account');
    expect(parsed.imported_count).toBe(0);
    expect(parsed.transaction_ids).toBeUndefined();
  });

  it('works in read-only mode, where write calls would throw', async () => {
    // No write-guarded client method is available, so any call would throw
    const readOnlyClient = { resolveBudgetId: () => 'test-budget-id' };

    const parsed = JSON.parse(await handleImportTransactions({}, readOnlyClient as never));

    expect(parsed.deprecated).toBe(true);
    expect(parsed.imported_count).toBe(0);
  });

  it('returns an empty id list when include_ids is true', async () => {
    const parsed = JSON.parse(
      await handleImportTransactions({ include_ids: true }, mockClient as never)
    );

    expect(parsed.transaction_ids).toEqual([]);
  });

  it('still validates and resolves budget_id', async () => {
    await handleImportTransactions({ budget_id: 'custom-budget' }, mockClient as never);

    expect(mockClient.resolveBudgetId).toHaveBeenCalledWith('custom-budget');
  });
});
