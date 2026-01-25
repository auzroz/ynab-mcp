/**
 * Tool Registry
 *
 * Central registry for all MCP tools. Each tool module exports:
 * - A Tool definition object
 * - A handler function
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../services/ynab-client.js';

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

// Payee tools
import { listPayeesTool, handleListPayees } from './payees/list-payees.js';
import { getPayeeTool, handleGetPayee } from './payees/get-payee.js';
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

// Scheduled transaction tools
import {
  listScheduledTransactionsTool,
  handleListScheduledTransactions,
} from './scheduled-transactions/list-scheduled.js';
import {
  getScheduledTransactionTool,
  handleGetScheduledTransaction,
} from './scheduled-transactions/get-scheduled.js';

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
} from './analytics/index.js';

// System tools
import {
  rateLimitStatusTool,
  handleRateLimitStatus,
  auditLogTool,
  handleAuditLog,
  healthCheckTool,
  handleHealthCheck,
} from './system/index.js';

// Export all tool definitions
export const tools: Tool[] = [
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
  // Payees
  listPayeesTool,
  getPayeeTool,
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
  listAccountTransactionsTool,
  listCategoryTransactionsTool,
  listPayeeTransactionsTool,
  importTransactionsTool,
  // Scheduled Transactions
  listScheduledTransactionsTool,
  getScheduledTransactionTool,
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
  // System
  rateLimitStatusTool,
  auditLogTool,
  healthCheckTool,
];

// Tool handler mapping
type ToolHandler = (args: Record<string, unknown>, client: YnabClient) => Promise<string>;

const handlers: Record<string, ToolHandler> = {
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
  // Payees
  ynab_list_payees: handleListPayees,
  ynab_get_payee: handleGetPayee,
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
  ynab_list_account_transactions: handleListAccountTransactions,
  ynab_list_category_transactions: handleListCategoryTransactions,
  ynab_list_payee_transactions: handleListPayeeTransactions,
  ynab_import_transactions: handleImportTransactions,
  // Scheduled Transactions
  ynab_list_scheduled_transactions: handleListScheduledTransactions,
  ynab_get_scheduled_transaction: handleGetScheduledTransaction,
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
  // System
  ynab_rate_limit_status: handleRateLimitStatus,
  ynab_audit_log: handleAuditLog,
  ynab_health_check: handleHealthCheck,
};

/**
 * Route a tool call to the appropriate handler.
 */
export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const handler = handlers[toolName];

  if (handler === undefined) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return handler(args, client);
}
