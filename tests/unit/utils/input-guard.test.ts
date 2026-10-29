import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  assertSafeToolInput,
  InputGuardError,
  MAX_ARRAY_LENGTH,
  MAX_DEPTH,
  MAX_SERIALIZED_BYTES,
} from '../../../src/utils/input-guard.js';
import { createServerForUser } from '../../../src/server.js';

function nested(depth: number): unknown {
  let v: unknown = 'leaf';
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

describe('assertSafeToolInput', () => {
  it('accepts a realistic 100-transaction bulk create with splits', () => {
    const transactions = Array.from({ length: 100 }, (_, i) => ({
      account_id: '11111111-1111-1111-1111-111111111111',
      date: '2024-01-01',
      amount: -1000 * i,
      payee_name: 'Some Payee',
      memo: 'm'.repeat(200),
      import_id: `YNAB:${i}`,
      subtransactions: [{ amount: -500, memo: 'a' }, { amount: -500, memo: 'b' }],
    }));
    expect(() => assertSafeToolInput({ budget_id: 'last-used', transactions })).not.toThrow();
  });

  it('accepts empty args and primitives', () => {
    expect(() => assertSafeToolInput({})).not.toThrow();
    expect(() => assertSafeToolInput(undefined)).not.toThrow();
  });

  it('rejects arrays over the length limit', () => {
    expect(() => assertSafeToolInput({ x: new Array(MAX_ARRAY_LENGTH + 1).fill(0) })).toThrow(
      InputGuardError
    );
    expect(() => assertSafeToolInput({ x: new Array(MAX_ARRAY_LENGTH).fill(0) })).not.toThrow();
  });

  it('rejects excessive nesting without overflowing the stack', () => {
    expect(() => assertSafeToolInput(nested(MAX_DEPTH + 1))).toThrow(InputGuardError);
    expect(() => assertSafeToolInput(nested(100000))).toThrow(InputGuardError);
    expect(() => assertSafeToolInput(nested(MAX_DEPTH - 1))).not.toThrow();
  });

  it('rejects oversized serialized payloads', () => {
    expect(() => assertSafeToolInput({ s: 'x'.repeat(MAX_SERIALIZED_BYTES + 1) })).toThrow(
      InputGuardError
    );
  });
});

describe('tools/call dispatch integration', () => {
  it('returns a normal tool error (no stack) before zod parsing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createServerForUser({
      accessToken: 'test-token',
      defaultBudgetId: undefined,
      readOnly: false,
      rateLimitPerHour: 180,
      cacheTtlMs: 300000,
    });
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({
      name: 'ynab_create_transactions',
      arguments: { transactions: new Array(MAX_ARRAY_LENGTH + 1).fill({}) },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    const body = JSON.parse(text);
    expect(body.type).toBe('validation_error');
    expect(body.field).toBe('arguments');
    expect(text).toMatch(/max 1000 items/);
    expect(body.issues).toBeUndefined();
    expect(text).not.toMatch(/\n\s+at /);

    // Input zod itself would accept (unknown keys are stripped): only the guard rejects it.
    const res2 = await client.callTool({
      name: 'ynab_list_accounts',
      arguments: { budget_id: 'last-used', extra: nested(MAX_DEPTH + 12) },
    });
    expect(res2.isError).toBe(true);
    const body2 = JSON.parse((res2.content as Array<{ text: string }>)[0]!.text);
    expect(body2.field).toBe('arguments');

    await client.close();
    await server.close();
    errSpy.mockRestore();
  });
});
