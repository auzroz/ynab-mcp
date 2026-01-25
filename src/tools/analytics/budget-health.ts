/**
 * Budget Health Tool
 *
 * Provides an overall budget health assessment with key metrics and alerts.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

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
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
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
  spent: string;
  available: string;
  status: 'on_track' | 'overspent' | 'underfunded' | 'warning';
  percent_used: number;
}

// Handler function
export async function handleBudgetHealth(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);

  // Get current month
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

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
      message: `You have ${formatCurrency(toBeBudgeted)} to be budgeted`,
      amount: formatCurrency(toBeBudgeted),
    });
  } else if (toBeBudgeted < 0) {
    alerts.push({
      severity: 'critical',
      type: 'overbudgeted',
      message: `You've budgeted ${formatCurrency(Math.abs(toBeBudgeted))} more than you have available`,
      amount: formatCurrency(Math.abs(toBeBudgeted)),
    });
  }

  // Analyze categories
  let totalOverspent = 0;
  let overspentCount = 0;
  let underfundedGoals = 0;

  for (const group of categoriesResponse.data.category_groups) {
    // Skip internal categories
    if (group.hidden || group.name === 'Internal Master Category') continue;

    for (const cat of group.categories) {
      if (cat.hidden || cat.deleted) continue;

      const budgeted = cat.budgeted;
      const activity = cat.activity;
      const balance = cat.balance;

      // Determine status
      let status: CategoryHealth['status'] = 'on_track';
      const percentUsed =
        budgeted !== 0 ? Math.round((Math.abs(activity) / budgeted) * 100) : 0;

      if (balance < 0) {
        status = 'overspent';
        totalOverspent += Math.abs(balance);
        overspentCount++;

        const safeCatName = sanitizeName(cat.name);
        alerts.push({
          severity: 'warning',
          type: 'overspent_category',
          message: `${safeCatName} is overspent by ${formatCurrency(Math.abs(balance))}`,
          category: safeCatName,
          amount: formatCurrency(Math.abs(balance)),
        });
      } else if (cat.goal_under_funded != null && cat.goal_under_funded > 0) {
        status = 'underfunded';
        underfundedGoals++;
        const underFunded = cat.goal_under_funded;

        const safeGoalName = sanitizeName(cat.name);
        alerts.push({
          severity: 'info',
          type: 'underfunded_goal',
          message: `${safeGoalName} needs ${formatCurrency(underFunded)} more to meet goal`,
          category: safeGoalName,
          amount: formatCurrency(underFunded),
        });
      } else if (percentUsed > 80 && balance > 0) {
        status = 'warning';
      }

      // Add significant categories to health report
      if (budgeted > 0 || Math.abs(activity) > 0) {
        categoryHealth.push({
          name: sanitizeName(cat.name),
          budgeted: formatCurrency(budgeted),
          spent: formatCurrency(Math.abs(activity)),
          available: formatCurrency(balance),
          status,
          percent_used: percentUsed,
        });
      }
    }
  }

  // Sort categories by status (problems first), then by amount spent
  const statusPriority = { overspent: 0, underfunded: 1, warning: 2, on_track: 3 };
  categoryHealth.sort((a, b) => {
    const priorityDiff = statusPriority[a.status] - statusPriority[b.status];
    if (priorityDiff !== 0) return priorityDiff;
    const amountA = parseFloat(a.spent.replace(/[^0-9.-]/g, ''));
    const amountB = parseFloat(b.spent.replace(/[^0-9.-]/g, ''));
    return amountB - amountA;
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

  return JSON.stringify(
    {
      health_score: healthScore,
      health_status: healthStatus,
      month: currentMonth,
      alerts: alerts.slice(0, 10), // Top 10 alerts
      key_metrics: {
        to_be_budgeted: formatCurrency(toBeBudgeted),
        total_budgeted: formatCurrency(totalBudgeted),
        total_spent: formatCurrency(Math.abs(totalActivity)),
        total_income: formatCurrency(totalIncome),
        total_overspent: formatCurrency(totalOverspent),
        overspent_category_count: overspentCount,
        underfunded_goals_count: underfundedGoals,
      },
      month_progress: {
        days_remaining: daysRemaining,
        percent_complete: percentMonthComplete,
        daily_budget_remaining:
          daysRemaining > 0
            ? formatCurrency(Math.round((totalBudgeted + totalActivity) / daysRemaining))
            : '$0.00',
      },
      category_health: categoryHealth.slice(0, 15), // Top 15 categories
      recommendations: generateRecommendations(alerts, healthScore, toBeBudgeted),
    },
    null,
    2
  );
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
