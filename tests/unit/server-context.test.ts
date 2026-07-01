/**
 * Per-user server context isolation (multi-tenant foundation).
 */

import { describe, it, expect } from 'vitest';
import { buildYnabClient, createServerForUser, type UserContext } from '../../src/server.js';

const baseCtx: Omit<UserContext, 'accessToken' | 'readOnly'> = {
  defaultBudgetId: undefined,
  rateLimitPerHour: 180,
  cacheTtlMs: 300000,
};

describe('buildYnabClient (per-user isolation)', () => {
  it('gives each user its own audit log instance', () => {
    const a = buildYnabClient({ ...baseCtx, accessToken: 'token-a', readOnly: false });
    const b = buildYnabClient({ ...baseCtx, accessToken: 'token-b', readOnly: false });

    expect(a.getAuditLog()).not.toBe(b.getAuditLog());
  });

  it('does not leak audit entries between users', () => {
    const a = buildYnabClient({ ...baseCtx, accessToken: 'token-a', readOnly: false });
    const b = buildYnabClient({ ...baseCtx, accessToken: 'token-b', readOnly: false });

    a.getAuditLog().log({
      operation: 'create',
      tool: 'ynab_create_payee',
      budgetId: 'bud-a',
      resourceType: 'payee',
      details: {},
      success: true,
    });

    expect(a.getAuditLog().getFiltered({}).length).toBe(1);
    expect(b.getAuditLog().getFiltered({}).length).toBe(0);
  });

  it('honors per-context read-only setting', () => {
    const ro = buildYnabClient({ ...baseCtx, accessToken: 't', readOnly: true });
    const rw = buildYnabClient({ ...baseCtx, accessToken: 't', readOnly: false });

    expect(ro.isReadOnly()).toBe(true);
    expect(rw.isReadOnly()).toBe(false);
  });
});

describe('createServerForUser', () => {
  it('builds an MCP Server bound to a per-user client', () => {
    const server = createServerForUser({ ...baseCtx, accessToken: 't', readOnly: true });
    // A Server exposes connect/close; enough to confirm we got a wired instance.
    expect(typeof server.connect).toBe('function');
    expect(typeof server.close).toBe('function');
  });
});
