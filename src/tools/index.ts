/**
 * Tool Registry
 *
 * Central registry for all MCP tools. Each tool module exports:
 * - A Tool definition object
 * - A handler function
 *
 * Titles and annotations live in ./annotations.ts and are merged in here when
 * the tool list is built.
 */

import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../services/ynab-client.js';
import { fanOutFor } from './fan-out.js';
import { ACCOUNT_TOOL_METADATA, TOOL_METADATA } from './annotations.js';
import { ACCOUNT_TOOL_NAMES, type AccountToolName } from './connections/policy.js';
import type { AccountToolContext, AccountToolHandler } from './connections/context.js';

// Account tools (OAuth HTTP mode only, #53c)
import { listConnectionsTool, handleListConnections } from './connections/list-connections.js';
import { revokeConnectionTool, handleRevokeConnection } from './connections/revoke-connection.js';
import { disconnectTool, handleDisconnect } from './connections/disconnect.js';

// User tools
import { getUserTool, handleGetUser } from './user/get-user.js';

// Budget tools
import { listBudgetsTool, handleListBudgets } from './budgets/list-budgets.js';
import { getBudgetTool, handleGetBudget } from './budgets/get-budget.js';
import {
  getBudgetSettingsTool,
  handleGetBudgetSettings,
} from './budgets/get-budget-settings.js';

// Account tools
import { listAccountsTool, handleListAccounts } from './accounts/list-accounts.js';
import { getAccountTool, handleGetAccount } from './accounts/get-account.js';
import { createAccountTool, handleCreateAccount } from './accounts/create-account.js';

// Category tools
import { listCategoriesTool, handleListCategories } from './categories/list-categories.js';
import { getCategoryTool, handleGetCategory } from './categories/get-category.js';
import {
  getMonthCategoryTool,
  handleGetMonthCategory,
} from './categories/get-month-category.js';
import { updateCategoryTool, handleUpdateCategory } from './categories/update-category.js';
import { moveMoneyTool, handleMoveMoney } from './categories/move-money.js';
import {
  updateCategoryDetailsTool,
  handleUpdateCategoryDetails,
} from './categories/update-category-details.js';
import { createCategoryTool, handleCreateCategory } from './categories/create-category.js';
import {
  createCategoryGroupTool,
  handleCreateCategoryGroup,
} from './categories/create-category-group.js';
import {
  updateCategoryGroupTool,
  handleUpdateCategoryGroup,
} from './categories/update-category-group.js';

// Payee tools
import { listPayeesTool, handleListPayees } from './payees/list-payees.js';
import { getPayeeTool, handleGetPayee } from './payees/get-payee.js';
import { createPayeeTool, handleCreatePayee } from './payees/create-payee.js';
import { updatePayeeTool, handleUpdatePayee } from './payees/update-payee.js';
import {
  listPayeeLocationsTool,
  handleListPayeeLocations,
} from './payees/list-payee-locations.js';
import {
  getPayeeLocationTool,
  handleGetPayeeLocation,
} from './payees/get-payee-location.js';
import {
  listPayeeLocationsByPayeeTool,
  handleListPayeeLocationsByPayee,
} from './payees/list-payee-locations-by-payee.js';

// Month tools
import { listMonthsTool, handleListMonths } from './months/list-months.js';
import { getMonthTool, handleGetMonth } from './months/get-month.js';

// Transaction tools
import {
  listTransactionsTool,
  handleListTransactions,
} from './transactions/list-transactions.js';
import {
  getTransactionTool,
  handleGetTransaction,
} from './transactions/get-transaction.js';
import {
  createTransactionTool,
  handleCreateTransaction,
} from './transactions/create-transaction.js';
import {
  updateTransactionTool,
  handleUpdateTransaction,
} from './transactions/update-transaction.js';
import {
  deleteTransactionTool,
  handleDeleteTransaction,
} from './transactions/delete-transaction.js';
import {
  createTransactionsTool,
  handleCreateTransactions,
} from './transactions/create-transactions.js';
import {
  listAccountTransactionsTool,
  handleListAccountTransactions,
} from './transactions/list-account-transactions.js';
import {
  listCategoryTransactionsTool,
  handleListCategoryTransactions,
} from './transactions/list-category-transactions.js';
import {
  listPayeeTransactionsTool,
  handleListPayeeTransactions,
} from './transactions/list-payee-transactions.js';
import {
  importTransactionsTool,
  handleImportTransactions,
} from './transactions/import-transactions.js';
import {
  updateTransactionsTool,
  handleUpdateTransactions,
} from './transactions/update-transactions.js';

// Scheduled transaction tools
import {
  listScheduledTransactionsTool,
  handleListScheduledTransactions,
} from './scheduled-transactions/list-scheduled.js';
import {
  getScheduledTransactionTool,
  handleGetScheduledTransaction,
} from './scheduled-transactions/get-scheduled.js';
import {
  createScheduledTransactionTool,
  handleCreateScheduledTransaction,
} from './scheduled-transactions/create-scheduled.js';
import {
  updateScheduledTransactionTool,
  handleUpdateScheduledTransaction,
} from './scheduled-transactions/update-scheduled.js';
import {
  deleteScheduledTransactionTool,
  handleDeleteScheduledTransaction,
} from './scheduled-transactions/delete-scheduled.js';

// Analytics tools
import {
  detectRecurringTool,
  handleDetectRecurring,
  spendingAnalysisTool,
  handleSpendingAnalysis,
  budgetHealthTool,
  handleBudgetHealth,
  savingsOpportunitiesTool,
  handleSavingsOpportunities,
  budgetVsActualsTool,
  handleBudgetVsActuals,
  quickSummaryTool,
  handleQuickSummary,
  incomeExpenseTool,
  handleIncomeExpense,
  netWorthTool,
  handleNetWorth,
  goalProgressTool,
  handleGoalProgress,
  spendingByPayeeTool,
  handleSpendingByPayee,
  unusedCategoriesTool,
  handleUnusedCategories,
  monthlyComparisonTool,
  handleMonthlyComparison,
  spendingTrendsTool,
  handleSpendingTrends,
  cashFlowForecastTool,
  handleCashFlowForecast,
  reconciliationHelperTool,
  handleReconciliationHelper,
  budgetSuggestionsTool,
  handleBudgetSuggestions,
  overspendingAlertsTool,
  handleOverspendingAlerts,
  transactionSearchTool,
  handleTransactionSearch,
  spendingPaceTool,
  handleSpendingPace,
  categoryBalancesTool,
  handleCategoryBalances,
  creditCardStatusTool,
  handleCreditCardStatus,
  ageOfMoneyTool,
  handleAgeOfMoney,
  previewScheduledTransactionTool,
  handlePreviewScheduledTransaction,
} from './analytics/index.js';

// Money movement tools
import {
  listMoneyMovementsTool,
  handleListMoneyMovements,
} from './money-movements/list-money-movements.js';
import {
  listMoneyMovementGroupsTool,
  handleListMoneyMovementGroups,
} from './money-movements/list-money-movement-groups.js';

// System tools
import {
  rateLimitStatusTool,
  handleRateLimitStatus,
  auditLogTool,
  handleAuditLog,
  healthCheckTool,
  handleHealthCheck,
} from './system/index.js';

// All tool definitions, as declared by the tool modules
const toolDefinitions: Tool[] = [
  // User
  getUserTool,
  // Budgets
  listBudgetsTool,
  getBudgetTool,
  getBudgetSettingsTool,
  // Accounts
  listAccountsTool,
  getAccountTool,
  createAccountTool,
  // Categories
  listCategoriesTool,
  getCategoryTool,
  getMonthCategoryTool,
  updateCategoryTool,
  moveMoneyTool,
  updateCategoryDetailsTool,
  createCategoryTool,
  createCategoryGroupTool,
  updateCategoryGroupTool,
  // Payees
  listPayeesTool,
  getPayeeTool,
  createPayeeTool,
  updatePayeeTool,
  listPayeeLocationsTool,
  getPayeeLocationTool,
  listPayeeLocationsByPayeeTool,
  // Months
  listMonthsTool,
  getMonthTool,
  // Transactions
  listTransactionsTool,
  getTransactionTool,
  createTransactionTool,
  updateTransactionTool,
  deleteTransactionTool,
  createTransactionsTool,
  updateTransactionsTool,
  listAccountTransactionsTool,
  listCategoryTransactionsTool,
  listPayeeTransactionsTool,
  importTransactionsTool,
  // Scheduled Transactions
  listScheduledTransactionsTool,
  getScheduledTransactionTool,
  createScheduledTransactionTool,
  updateScheduledTransactionTool,
  deleteScheduledTransactionTool,
  // Analytics
  detectRecurringTool,
  spendingAnalysisTool,
  budgetHealthTool,
  savingsOpportunitiesTool,
  budgetVsActualsTool,
  quickSummaryTool,
  incomeExpenseTool,
  netWorthTool,
  goalProgressTool,
  spendingByPayeeTool,
  unusedCategoriesTool,
  monthlyComparisonTool,
  spendingTrendsTool,
  cashFlowForecastTool,
  reconciliationHelperTool,
  budgetSuggestionsTool,
  overspendingAlertsTool,
  transactionSearchTool,
  spendingPaceTool,
  categoryBalancesTool,
  creditCardStatusTool,
  ageOfMoneyTool,
  previewScheduledTransactionTool,
  // Money Movements
  listMoneyMovementsTool,
  listMoneyMovementGroupsTool,
  // System
  rateLimitStatusTool,
  auditLogTool,
  healthCheckTool,
];

// Tool handler mapping. A tool with an outputSchema returns its output object
// (serialized here); every other tool returns its JSON text (#45).
type ToolHandler = (
  args: Record<string, unknown>,
  client: YnabClient
) => Promise<string | Record<string, unknown>>;

const handlers = {
  // User
  ynab_get_user: handleGetUser,
  // Budgets
  ynab_list_budgets: handleListBudgets,
  ynab_get_budget: handleGetBudget,
  ynab_get_budget_settings: handleGetBudgetSettings,
  // Accounts
  ynab_list_accounts: handleListAccounts,
  ynab_get_account: handleGetAccount,
  ynab_create_account: handleCreateAccount,
  // Categories
  ynab_list_categories: handleListCategories,
  ynab_get_category: handleGetCategory,
  ynab_get_month_category: handleGetMonthCategory,
  ynab_update_category: handleUpdateCategory,
  ynab_move_money: handleMoveMoney,
  ynab_update_category_details: handleUpdateCategoryDetails,
  ynab_create_category: handleCreateCategory,
  ynab_create_category_group: handleCreateCategoryGroup,
  ynab_update_category_group: handleUpdateCategoryGroup,
  // Payees
  ynab_list_payees: handleListPayees,
  ynab_get_payee: handleGetPayee,
  ynab_create_payee: handleCreatePayee,
  ynab_update_payee: handleUpdatePayee,
  ynab_list_payee_locations: handleListPayeeLocations,
  ynab_get_payee_location: handleGetPayeeLocation,
  ynab_list_payee_locations_by_payee: handleListPayeeLocationsByPayee,
  // Months
  ynab_list_months: handleListMonths,
  ynab_get_month: handleGetMonth,
  // Transactions
  ynab_list_transactions: handleListTransactions,
  ynab_get_transaction: handleGetTransaction,
  ynab_create_transaction: handleCreateTransaction,
  ynab_update_transaction: handleUpdateTransaction,
  ynab_delete_transaction: handleDeleteTransaction,
  ynab_create_transactions: handleCreateTransactions,
  ynab_update_transactions: handleUpdateTransactions,
  ynab_list_account_transactions: handleListAccountTransactions,
  ynab_list_category_transactions: handleListCategoryTransactions,
  ynab_list_payee_transactions: handleListPayeeTransactions,
  ynab_import_transactions: handleImportTransactions,
  // Scheduled Transactions
  ynab_list_scheduled_transactions: handleListScheduledTransactions,
  ynab_get_scheduled_transaction: handleGetScheduledTransaction,
  ynab_create_scheduled_transaction: handleCreateScheduledTransaction,
  ynab_update_scheduled_transaction: handleUpdateScheduledTransaction,
  ynab_delete_scheduled_transaction: handleDeleteScheduledTransaction,
  // Analytics
  ynab_detect_recurring: handleDetectRecurring,
  ynab_spending_analysis: handleSpendingAnalysis,
  ynab_budget_health: handleBudgetHealth,
  ynab_savings_opportunities: handleSavingsOpportunities,
  ynab_budget_vs_actuals: handleBudgetVsActuals,
  ynab_quick_summary: handleQuickSummary,
  ynab_income_expense: handleIncomeExpense,
  ynab_net_worth: handleNetWorth,
  ynab_goal_progress: handleGoalProgress,
  ynab_spending_by_payee: handleSpendingByPayee,
  ynab_unused_categories: handleUnusedCategories,
  ynab_monthly_comparison: handleMonthlyComparison,
  ynab_spending_trends: handleSpendingTrends,
  ynab_cash_flow_forecast: handleCashFlowForecast,
  ynab_reconciliation_helper: handleReconciliationHelper,
  ynab_budget_suggestions: handleBudgetSuggestions,
  ynab_overspending_alerts: handleOverspendingAlerts,
  ynab_transaction_search: handleTransactionSearch,
  ynab_spending_pace: handleSpendingPace,
  ynab_category_balances: handleCategoryBalances,
  ynab_credit_card_status: handleCreditCardStatus,
  ynab_age_of_money: handleAgeOfMoney,
  ynab_preview_scheduled_transaction: handlePreviewScheduledTransaction,
  // Money Movements
  ynab_list_money_movements: handleListMoneyMovements,
  ynab_list_money_movement_groups: handleListMoneyMovementGroups,
  // System
  ynab_rate_limit_status: handleRateLimitStatus,
  ynab_audit_log: handleAuditLog,
  ynab_health_check: handleHealthCheck,
} satisfies Record<string, ToolHandler>;

/** Names of all registered tools. TOOL_METADATA must have exactly these keys. */
export type ToolName = keyof typeof handlers;

function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(handlers, name);
}

/**
 * Attach the title and annotations from TOOL_METADATA to a tool definition.
 * Throws for a tool with no handler/metadata entry, so a registration mistake
 * fails at startup (and in tests) instead of shipping a tool that clients
 * would treat with the spec's defaults (destructive, open world).
 */
function withMetadata(tool: Tool): Tool {
  if (!isToolName(tool.name)) {
    throw new Error(`Tool ${tool.name} has no handler or annotation entry`);
  }
  const { title, annotations } = TOOL_METADATA[tool.name];
  // Top-level title is the 2025-06-18 display name; annotations.title is the
  // 2025-03-26 field older clients read. Both carry the same value.
  return { ...tool, title, annotations: { title, ...annotations } };
}

// Export all tool definitions with titles and annotations applied
export const tools: Tool[] = toolDefinitions.map(withMetadata);

// ---- Account tools (#53c) ---------------------------------------------------
// Registered only in OAuth HTTP mode, where a user has connections: stdio and
// header mode never list them, and a call by name there is an unknown tool.
// They run with an AccountToolContext instead of a YnabClient, and make no
// YNAB request.

const accountHandlers = {
  ynab_list_connections: handleListConnections,
  ynab_revoke_connection: handleRevokeConnection,
  ynab_disconnect: handleDisconnect,
} satisfies Record<AccountToolName, AccountToolHandler>;

const accountToolDefinitions: Tool[] = [listConnectionsTool, revokeConnectionTool, disconnectTool];

/** The account tools with titles and annotations, in ACCOUNT_TOOL_NAMES order. */
export const accountTools: Tool[] = accountToolDefinitions.map((tool) => {
  if (!isAccountToolName(tool.name)) throw new Error(`Tool ${tool.name} has no account handler or annotation entry`);
  const { title, annotations } = ACCOUNT_TOOL_METADATA[tool.name];
  return { ...tool, title, annotations: { title, ...annotations } };
});

/** Every tool the server can register in some mode: the docs and the site count these. */
export const toolCatalog: Tool[] = [...tools, ...accountTools];

export function isAccountToolName(name: string): name is AccountToolName {
  return (ACCOUNT_TOOL_NAMES as readonly string[]).includes(name);
}

/** Run an account tool. The caller has already applied its policy (src/tools/connections/policy.ts). */
export async function handleAccountToolCall(
  toolName: AccountToolName,
  args: Record<string, unknown>,
  ctx: AccountToolContext
): Promise<string> {
  const handler: AccountToolHandler = accountHandlers[toolName];
  return handler(args, ctx);
}

const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** The advertised definition of a registered tool (the object tools/list sends). */
export function getTool(name: string): Tool | undefined {
  return toolsByName.get(name);
}

/**
 * A tool call's result: the text block, and for a tool with an outputSchema
 * the object that text was serialized from (its `structuredContent`).
 */
export interface ToolCallOutput {
  text: string;
  structured?: Record<string, unknown>;
}

/**
 * Route a tool call to its handler and return its text and, for a tool with
 * an outputSchema, its structured output. The text is serialized from the
 * structured object itself (never the reverse), so the two always agree, and
 * a tool with a schema never answers without it.
 */
export async function runToolCall(
  toolName: string,
  args: Record<string, unknown>,
  client: YnabClient
): Promise<ToolCallOutput> {
  return toolCallOutput(toolsByName.get(toolName), await dispatch(toolName, args, client));
}

/** A handler's return value as a tool call's output, by the tool's definition (see runToolCall). */
export function toolCallOutput(tool: Tool | undefined, result: string | Record<string, unknown>): ToolCallOutput {
  const toolName = tool?.name ?? 'unknown';
  const hasSchema = tool?.outputSchema !== undefined;
  if (typeof result === 'string') {
    // A v2 client rejects a non-error result without structuredContent from a
    // tool that has a schema, so this is a bug, reported as a tool error.
    if (hasSchema) throw new Error(`Tool ${toolName} has an output schema but returned text only`);
    return { text: result };
  }
  const text = JSON.stringify(result, null, 2);
  return hasSchema ? { text, structured: result } : { text };
}

/**
 * Route a tool call to the appropriate handler and return its text block
 * (the JSON the tool has always returned).
 */
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  return (await runToolCall(toolName, args, client)).text;
}

async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string | Record<string, unknown>> {
  // Guard against prototype pollution - only allow own properties
  if (!isToolName(toolName)) {
    const safeName = toolName.slice(0, 100).replace(/[\r\n]/g, '');
    throw new Error(`Unknown tool: ${safeName}`);
  }

  // Safe to access after hasOwnProperty check
  const handler: ToolHandler = handlers[toolName];
  // A tool that fans out into several YNAB requests reserves them all up front (#58).
  return client.withFanOut(fanOutFor(toolName, args), () => handler(args, client));
}
