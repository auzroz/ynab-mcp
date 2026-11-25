/**
 * What each write tool does, as the audit log names it (#60a). The tools/call
 * handler records a refused write (read-only mode, a read-only grant, the
 * write cap) and a write that failed before its YNAB request with these; a
 * write that reached YNAB is recorded by the client method with its
 * resource id. tests/unit/tools/audit-targets.test.ts checks that every
 * non-read-only tool has an entry.
 */

import type { AuditOperation, AuditResourceType } from '../storage/audit-rows.js';

export interface AuditTarget {
  operation: AuditOperation;
  resourceType: AuditResourceType;
}

export const WRITE_TOOL_AUDIT_TARGETS: Readonly<Record<string, AuditTarget>> = {
  ynab_create_account: { operation: 'create', resourceType: 'account' },
  ynab_update_category: { operation: 'update', resourceType: 'category' },
  ynab_move_money: { operation: 'move', resourceType: 'category' },
  ynab_update_category_details: { operation: 'update', resourceType: 'category' },
  ynab_create_category: { operation: 'create', resourceType: 'category' },
  ynab_create_category_group: { operation: 'create', resourceType: 'category_group' },
  ynab_update_category_group: { operation: 'update', resourceType: 'category_group' },
  ynab_create_payee: { operation: 'create', resourceType: 'payee' },
  ynab_update_payee: { operation: 'update', resourceType: 'payee' },
  ynab_create_transaction: { operation: 'create', resourceType: 'transaction' },
  ynab_update_transaction: { operation: 'update', resourceType: 'transaction' },
  ynab_delete_transaction: { operation: 'delete', resourceType: 'transaction' },
  ynab_create_transactions: { operation: 'create', resourceType: 'transaction' },
  ynab_update_transactions: { operation: 'update', resourceType: 'transaction' },
  ynab_import_transactions: { operation: 'import', resourceType: 'transaction' },
  ynab_create_scheduled_transaction: { operation: 'create', resourceType: 'scheduled_transaction' },
  ynab_update_scheduled_transaction: { operation: 'update', resourceType: 'scheduled_transaction' },
  ynab_delete_scheduled_transaction: { operation: 'delete', resourceType: 'scheduled_transaction' },
};
