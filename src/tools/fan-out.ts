/**
 * Fan-out of the multi-request analytics tools (#58).
 *
 * A tool that reads several YNAB resources at once (a month, the categories, a
 * run of earlier months, ...) would, with one rate-limit token per call, fail
 * part-way when the bucket ran low: some calls made, the rest refused, the work
 * wasted. handleToolCall reserves the tool's whole fan-out up front instead
 * (YnabClient.withFanOut): all of it, or a RateLimitError with the retry time
 * before anything is sent. Reads served from the cache give their tokens back
 * when the tool ends.
 *
 * Each entry is the most requests a call of that tool makes when nothing is
 * cached (one per read it issues). A tool not listed makes at most one request
 * per call, which acquire() already takes atomically.
 */

type Args = Record<string, unknown>;

function monthsArg(args: Args, fallback: number): number {
  const value = args['months'];
  // The tool's own schema bounds it (2-12 or 1-12); this only keeps the reservation sane.
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(12, Math.max(1, value)) : fallback;
}

/** Requests a tool call makes at most, for the tools that make several. */
export const FAN_OUT: Readonly<Record<string, (args: Args) => number>> = {
  ynab_age_of_money: () => 2,
  ynab_budget_health: () => 2,
  // categories, the current month and each earlier month
  ynab_budget_suggestions: (args) => 2 + monthsArg(args, 3),
  ynab_budget_vs_actuals: (args) => 2 + (args['include_previous'] === true ? 1 : 0),
  ynab_cash_flow_forecast: () => 2,
  ynab_category_balances: () => 2,
  ynab_credit_card_status: () => 3,
  ynab_goal_progress: () => 2,
  ynab_monthly_comparison: () => 3,
  ynab_overspending_alerts: () => 2,
  ynab_preview_scheduled_transaction: (args) => 1 + (args['category_id'] ? 1 : 0) + (args['payee_id'] ? 1 : 0),
  ynab_quick_summary: () => 2,
  ynab_reconciliation_helper: () => 3,
  ynab_savings_opportunities: () => 2,
  ynab_spending_analysis: () => 2,
  ynab_spending_pace: () => 2,
  // categories and each month
  ynab_spending_trends: (args) => 1 + monthsArg(args, 6),
  // transactions, categories and accounts, plus the budget's first month for an until_date alone
  ynab_transaction_search: () => 4,
  ynab_unused_categories: () => 2,
};

/** How many requests a tool call needs reserved (1 when it makes at most one). */
export function fanOutFor(toolName: string, args: Args): number {
  const fn = Object.hasOwn(FAN_OUT, toolName) ? FAN_OUT[toolName] : undefined;
  return fn === undefined ? 1 : fn(args);
}
