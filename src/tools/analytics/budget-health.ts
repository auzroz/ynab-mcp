/**
 * Budget Health Tool
 *
 * Provides an overall budget health assessment with key metrics and alerts.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { budgetId } from '../../utils/schemas.js';
import { isInternalGroup } from '../../utils/categories.js';
import { toOutputSchema } from '../output-schema.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

/** What the tool returns (#45; rules in ../output-schema.ts). Amounts are formatted strings, *_milliunits raw. */
export const budgetHealthOutputSchema = z.object({
  health_score: z.number().int().describe('0 to 100'),
  health_status: z.enum(['excellent', 'good', 'fair', 'poor']),
  month: z.string(),
  alerts: z
    .array(
      z.object({
        severity: z.enum(['critical', 'warning', 'info']),
        type: z.string().describe('unbudgeted_funds, overbudgeted, overspent_category or underfunded_goal'),
        message: z.string(),
        category: z.string().exactOptional(),
        amount: z.string().exactOptional(),
      })
    )
    .describe('At most 10, most severe first'),
  key_metrics: z.object({
    to_be_budgeted: z.string(),
    total_budgeted: z.string(),
    total_spent: z.string(),
    total_income: z.string(),
    total_overspent: z.string(),
    overspent_category_count: z.number().int(),
    underfunded_goals_count: z.number().int(),
  }),
  month_progress: z.object({
    days_remaining: z.number().int(),
    percent_complete: z.number().int(),
    daily_budget_remaining: z.string(),
    daily_budget_remaining_milliunits: z.number().int(),
  }),
  category_health: z
    .array(
      z.object({
        name: z.string(),
        budgeted: z.string(),
        budgeted_milliunits: z.number().int(),
        spent: z.string(),
        spent_milliunits: z.number().int(),
        available: z.string(),
        available_milliunits: z.number().int(),
        status: z.enum(['on_track', 'overspent', 'underfunded', 'warning']),
        percent_used: z.number().int(),
      })
    )
    .describe('At most 15, problems first'),
  recommendations: z.array(z.string()),
});
export type BudgetHealthOutput = z.output<typeof budgetHealthOutputSchema>;

// Tool definition
export const budgetHealthTool: Tool = {
  name: 'ynab_budget_health',
  description: `Get an overall budget health assessment.

Use when the user asks:
- "How is my budget doing?"
- "What's my budget status?"
- "Am I on track this month?"
- "Budget health check"
- "Any budget problems?"

Provides key metrics, alerts, and recommendations.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
  outputSchema: toOutputSchema(budgetHealthOutputSchema),
};

interface HealthAlert {
  severity: 'critical' | 'warning' | 'info';
  type: string;
  message: string;
  category?: string;
  amount?: string;
}

interface CategoryHealth {
  name: string;
  budgeted: string;
  budgeted_milliunits: number;
  spent: string;
  spent_milliunits: number;
  available: string;
  available_milliunits: number;
  status: 'on_track' | 'overspent' | 'underfunded' | 'warning';
  percent_used: number;
}

// Handler function
/**
 * Handler for the ynab_budget_health tool.
 */
export async function handleBudgetHealth(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<BudgetHealthOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);

  // Get current month (UTC-based for YNAB API consistency)
  const currentMonth = getCurrentMonth();
  const now = new Date();

  // Get budget data
  const [monthResponse, categoriesResponse] = await Promise.all([
    client.getBudgetMonth(budgetId, currentMonth),
    client.getCategories(budgetId),
  ]);

  const month = monthResponse.data.month;
  const alerts: HealthAlert[] = [];
  const categoryHealth: CategoryHealth[] = [];

  // Key metrics
  const toBeBudgeted = month.to_be_budgeted;
  const totalBudgeted = month.budgeted;
  const totalActivity = month.activity;
  const totalIncome = month.income;

  // Alert: Money to be budgeted
  if (toBeBudgeted > 0) {
    alerts.push({
      severity: 'info',
      type: 'unbudgeted_funds',
      message: `You have ${money(toBeBudgeted)} to be budgeted`,
      amount: money(toBeBudgeted),
    });
  } else if (toBeBudgeted < 0) {
    alerts.push({
      severity: 'critical',
      type: 'overbudgeted',
      message: `You've budgeted ${money(Math.abs(toBeBudgeted))} more than you have available`,
      amount: money(Math.abs(toBeBudgeted)),
    });
  }

  // Analyze categories
  let totalOverspent = 0;
  let overspentCount = 0;
  let underfundedGoals = 0;

  for (const group of categoriesResponse.data.category_groups) {
    // Skip internal categories
    if (group.hidden || isInternalGroup(group)) continue;

    for (const cat of group.categories) {
      if (cat.hidden || cat.deleted) continue;

      const budgeted = cat.budgeted;
      const activity = cat.activity;
      const balance = cat.balance;

      // Determine status
      let status: CategoryHealth['status'] = 'on_track';
      // Use absolute value of budgeted to handle negative budgets correctly
      const percentUsed =
        budgeted !== 0 ? Math.round((Math.abs(activity) / Math.abs(budgeted)) * 100) : 0;

      if (balance < 0) {
        status = 'overspent';
        totalOverspent += Math.abs(balance);
        overspentCount++;

        const safeCatName = sanitizeName(cat.name);
        alerts.push({
          severity: 'warning',
          type: 'overspent_category',
          message: `${safeCatName} is overspent by ${money(Math.abs(balance))}`,
          category: safeCatName,
          amount: money(Math.abs(balance)),
        });
      } else if (cat.goal_under_funded != null && cat.goal_under_funded > 0) {
        status = 'underfunded';
        underfundedGoals++;
        const underFunded = cat.goal_under_funded;

        const safeGoalName = sanitizeName(cat.name);
        alerts.push({
          severity: 'info',
          type: 'underfunded_goal',
          message: `${safeGoalName} needs ${money(underFunded)} more to meet goal`,
          category: safeGoalName,
          amount: money(underFunded),
        });
      } else if (percentUsed > 80 && balance > 0) {
        status = 'warning';
      }

      // Add significant categories to health report
      if (budgeted > 0 || Math.abs(activity) > 0) {
        categoryHealth.push({
          name: sanitizeName(cat.name),
          budgeted: money(budgeted),
          budgeted_milliunits: budgeted,
          spent: money(Math.abs(activity)),
          spent_milliunits: Math.abs(activity),
          available: money(balance),
          available_milliunits: balance,
          status,
          percent_used: percentUsed,
        });
      }
    }
  }

  // Sort categories by status (problems first), then by amount spent (using raw milliunits)
  const statusPriority = { overspent: 0, underfunded: 1, warning: 2, on_track: 3 };
  categoryHealth.sort((a, b) => {
    const priorityDiff = statusPriority[a.status] - statusPriority[b.status];
    if (priorityDiff !== 0) return priorityDiff;
    // Use raw milliunits for accurate numeric sorting
    return b.spent_milliunits - a.spent_milliunits;
  });

  // Calculate overall health score (0-100)
  let healthScore = 100;

  // Deductions
  if (toBeBudgeted < 0) healthScore -= 30; // Overbudgeted
  if (overspentCount > 0) healthScore -= Math.min(overspentCount * 10, 30);
  if (underfundedGoals > 0) healthScore -= Math.min(underfundedGoals * 2, 10);

  healthScore = Math.max(0, healthScore);

  // Determine health status
  let healthStatus: 'excellent' | 'good' | 'fair' | 'poor';
  if (healthScore >= 90) healthStatus = 'excellent';
  else if (healthScore >= 70) healthStatus = 'good';
  else if (healthScore >= 50) healthStatus = 'fair';
  else healthStatus = 'poor';

  // Sort alerts by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Calculate days left in month
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysRemaining = daysInMonth - dayOfMonth;
  const percentMonthComplete = Math.round((dayOfMonth / daysInMonth) * 100);

  return {
    health_score: healthScore,
    health_status: healthStatus,
    month: currentMonth,
    alerts: alerts.slice(0, 10), // Top 10 alerts
    key_metrics: {
      to_be_budgeted: money(toBeBudgeted),
      total_budgeted: money(totalBudgeted),
      total_spent: money(Math.abs(totalActivity)),
      total_income: money(totalIncome),
      total_overspent: money(totalOverspent),
      overspent_category_count: overspentCount,
      underfunded_goals_count: underfundedGoals,
    },
    month_progress: {
      days_remaining: daysRemaining,
      percent_complete: percentMonthComplete,
      daily_budget_remaining:
        daysRemaining > 0
          ? money(Math.round((totalBudgeted + totalActivity) / daysRemaining))
          : money(totalBudgeted + totalActivity), // Last day: show remaining budget
      daily_budget_remaining_milliunits:
        daysRemaining > 0
          ? Math.round((totalBudgeted + totalActivity) / daysRemaining)
          : totalBudgeted + totalActivity,
    },
    category_health: categoryHealth.slice(0, 15), // Top 15 categories
    recommendations: generateRecommendations(alerts, healthScore, toBeBudgeted),
  };
}

function generateRecommendations(
  alerts: HealthAlert[],
  healthScore: number,
  toBeBudgeted: number
): string[] {
  const recommendations: string[] = [];

  const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
  const overspentAlerts = alerts.filter((a) => a.type === 'overspent_category');

  if (criticalAlerts.length > 0) {
    recommendations.push(
      'Address critical issues first: reduce category budgets to fix overbudgeting'
    );
  }

  if (overspentAlerts.length > 0) {
    recommendations.push(
      `Cover ${overspentAlerts.length} overspent categor${overspentAlerts.length === 1 ? 'y' : 'ies'} by moving money from other categories`
    );
  }

  if (toBeBudgeted > 0) {
    recommendations.push('Assign your available funds to categories or goals');
  }

  if (healthScore < 70) {
    recommendations.push('Review your budget and spending to get back on track');
  }

  if (healthScore >= 90) {
    recommendations.push('Great job! Your budget is in excellent shape');
  }

  return recommendations;
}
