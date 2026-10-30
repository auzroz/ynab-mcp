/**
 * Tool Titles and Annotations
 *
 * One table giving every registered tool a display title and the four MCP
 * ToolAnnotations hints. src/tools/index.ts applies it when building the
 * tools/list response, so tool modules do not repeat this metadata.
 *
 * Conventions (MCP 2025-06-18 ToolAnnotations):
 * - Every hint is set explicitly. The spec defaults are unsafe for us when
 *   omitted: destructiveHint defaults to true, idempotentHint to false and
 *   openWorldHint to true.
 * - readOnlyHint: true for tools that only read. Every tool named for a
 *   create, update, delete or import action is false. That includes the
 *   deprecated import tool, which is now a no-op: its name still advertises a
 *   write, and a client should not be told it may run it unprompted.
 * - destructiveHint: the spec says false means "only additive updates". True
 *   for the two delete tools and for every update tool, because updates
 *   overwrite fields in place (memo, amount, category, cleared status, budgeted
 *   amount, names) and the old value is not recoverable through the API.
 *   Creates, reads and the no-op import are false.
 * - idempotentHint: true when repeating the call with the same arguments leaves
 *   the budget in the same state: reads, updates that set absolute values by
 *   id, deletes by id, and the no-op import. Creates are false because each
 *   call adds a new record.
 * - openWorldHint: false for every tool. They act only on the user's own YNAB
 *   budget (a closed domain), never on arbitrary external entities.
 *
 * These are hints for clients, not a security boundary. Read-only mode is
 * still enforced server-side.
 *
 * The table is checked against the registered tool names at compile time
 * (`satisfies Record<ToolName, ToolMetadata>` rejects missing and unknown
 * keys), and tests/unit/tools/annotations.test.ts checks the hint rules.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolName } from './index.js';

export interface ToolMetadata {
  title: string;
  annotations: Required<
    Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
  >;
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const UPDATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// The deprecated import tool makes no API call, so nothing is overwritten.
const NOOP_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// Shifts budgeted money between two categories: overwrites both amounts, and
// repeating the call moves the money again, so it is not idempotent.
const MOVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_METADATA = {
  // User
  ynab_get_user: { title: 'Get User', annotations: READ },
  // Budgets
  ynab_list_budgets: { title: 'List Budgets', annotations: READ },
  ynab_get_budget: { title: 'Get Budget', annotations: READ },
  ynab_get_budget_settings: { title: 'Get Budget Settings', annotations: READ },
  // Accounts
  ynab_list_accounts: { title: 'List Accounts', annotations: READ },
  ynab_get_account: { title: 'Get Account', annotations: READ },
  ynab_create_account: { title: 'Create Account', annotations: CREATE },
  // Categories
  ynab_list_categories: { title: 'List Categories', annotations: READ },
  ynab_get_category: { title: 'Get Category', annotations: READ },
  ynab_get_month_category: { title: 'Get Month Category', annotations: READ },
  // Sets an absolute budgeted amount for one month, so repeats are no-ops.
  ynab_update_category: { title: 'Update Category Budget', annotations: UPDATE },
  ynab_move_money: { title: 'Move Money Between Categories', annotations: MOVE },
  ynab_update_category_details: { title: 'Update Category Details', annotations: UPDATE },
  ynab_create_category: { title: 'Create Category', annotations: CREATE },
  ynab_create_category_group: { title: 'Create Category Group', annotations: CREATE },
  ynab_update_category_group: { title: 'Rename Category Group', annotations: UPDATE },
  // Payees
  ynab_list_payees: { title: 'List Payees', annotations: READ },
  ynab_get_payee: { title: 'Get Payee', annotations: READ },
  ynab_create_payee: { title: 'Create Payee', annotations: CREATE },
  ynab_update_payee: { title: 'Rename Payee', annotations: UPDATE },
  ynab_list_payee_locations: { title: 'List Payee Locations', annotations: READ },
  ynab_get_payee_location: { title: 'Get Payee Location', annotations: READ },
  ynab_list_payee_locations_by_payee: {
    title: 'List Locations for Payee',
    annotations: READ,
  },
  // Months
  ynab_list_months: { title: 'List Budget Months', annotations: READ },
  ynab_get_month: { title: 'Get Budget Month', annotations: READ },
  // Transactions
  ynab_list_transactions: { title: 'List Transactions', annotations: READ },
  ynab_get_transaction: { title: 'Get Transaction', annotations: READ },
  ynab_create_transaction: { title: 'Create Transaction', annotations: CREATE },
  ynab_update_transaction: { title: 'Update Transaction', annotations: UPDATE },
  ynab_delete_transaction: { title: 'Delete Transaction', annotations: DELETE },
  ynab_create_transactions: { title: 'Create Transactions in Bulk', annotations: CREATE },
  ynab_update_transactions: { title: 'Update Transactions in Bulk', annotations: UPDATE },
  ynab_list_account_transactions: { title: 'List Account Transactions', annotations: READ },
  ynab_list_category_transactions: { title: 'List Category Transactions', annotations: READ },
  ynab_list_payee_transactions: { title: 'List Payee Transactions', annotations: READ },
  // Deprecated no-op: makes no API call, so it is idempotent and not
  // destructive, but it keeps readOnlyHint false because it is named as a write.
  ynab_import_transactions: {
    title: 'Import Transactions (Deprecated)',
    annotations: NOOP_WRITE,
  },
  // Scheduled Transactions
  ynab_list_scheduled_transactions: { title: 'List Scheduled Transactions', annotations: READ },
  ynab_get_scheduled_transaction: { title: 'Get Scheduled Transaction', annotations: READ },
  ynab_create_scheduled_transaction: {
    title: 'Create Scheduled Transaction',
    annotations: CREATE,
  },
  ynab_update_scheduled_transaction: {
    title: 'Update Scheduled Transaction',
    annotations: UPDATE,
  },
  ynab_delete_scheduled_transaction: {
    title: 'Delete Scheduled Transaction',
    annotations: DELETE,
  },
  // Analytics (all computed from reads)
  ynab_detect_recurring: { title: 'Detect Recurring Transactions', annotations: READ },
  ynab_spending_analysis: { title: 'Spending Analysis', annotations: READ },
  ynab_budget_health: { title: 'Budget Health Check', annotations: READ },
  ynab_savings_opportunities: { title: 'Find Savings Opportunities', annotations: READ },
  ynab_budget_vs_actuals: { title: 'Budget vs Actuals', annotations: READ },
  ynab_quick_summary: { title: 'Quick Budget Summary', annotations: READ },
  ynab_income_expense: { title: 'Income vs Expenses', annotations: READ },
  ynab_net_worth: { title: 'Net Worth', annotations: READ },
  ynab_goal_progress: { title: 'Goal Progress', annotations: READ },
  ynab_spending_by_payee: { title: 'Spending by Payee', annotations: READ },
  ynab_unused_categories: { title: 'Find Unused Categories', annotations: READ },
  ynab_monthly_comparison: { title: 'Monthly Comparison', annotations: READ },
  ynab_spending_trends: { title: 'Spending Trends', annotations: READ },
  ynab_cash_flow_forecast: { title: 'Cash Flow Forecast', annotations: READ },
  ynab_reconciliation_helper: { title: 'Reconciliation Helper', annotations: READ },
  ynab_budget_suggestions: { title: 'Budget Suggestions', annotations: READ },
  ynab_overspending_alerts: { title: 'Overspending Alerts', annotations: READ },
  ynab_transaction_search: { title: 'Search Transactions', annotations: READ },
  ynab_spending_pace: { title: 'Spending Pace', annotations: READ },
  ynab_category_balances: { title: 'Category Balances', annotations: READ },
  ynab_credit_card_status: { title: 'Credit Card Status', annotations: READ },
  ynab_age_of_money: { title: 'Age of Money', annotations: READ },
  ynab_preview_scheduled_transaction: {
    title: 'Preview Scheduled Transactions',
    annotations: READ,
  },
  // Money Movements
  ynab_list_money_movements: { title: 'List Money Movements', annotations: READ },
  ynab_list_money_movement_groups: { title: 'List Money Movement Groups', annotations: READ },
  // System (local server state plus one getUser probe in the health check)
  ynab_rate_limit_status: { title: 'Rate Limit Status', annotations: READ },
  ynab_audit_log: { title: 'View Audit Log', annotations: READ },
  ynab_health_check: { title: 'Health Check', annotations: READ },
} as const satisfies Record<ToolName, ToolMetadata>;
