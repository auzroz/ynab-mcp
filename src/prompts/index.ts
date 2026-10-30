/**
 * Prompt Registry
 *
 * Central registry for all MCP prompts. Each prompt module exports:
 * - A Prompt definition object
 * - A message-builder function
 */

import type { Prompt, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

import { pulseCheckPrompt, buildPulseCheckMessages } from './pulse-check.js';
import { monthlyReviewPrompt, buildMonthlyReviewMessages } from './monthly-review.js';
import { assignMoneyPrompt, buildAssignMoneyMessages } from './assign-money.js';
import { trueExpensesPrompt, buildTrueExpensesMessages } from './true-expenses.js';
import { overspendingTriagePrompt, buildOverspendingTriageMessages } from './overspending-triage.js';
import { ageOfMoneyPrompt, buildAgeOfMoneyMessages } from './age-of-money.js';
import { reconcileCleanupPrompt, buildReconcileCleanupMessages } from './reconcile-cleanup.js';
import { UnknownPromptError } from './errors.js';

export { UnknownPromptError, InvalidPromptArgumentsError } from './errors.js';

export const prompts: Prompt[] = [
  pulseCheckPrompt,
  monthlyReviewPrompt,
  assignMoneyPrompt,
  trueExpensesPrompt,
  overspendingTriagePrompt,
  ageOfMoneyPrompt,
  reconcileCleanupPrompt,
];

type PromptMessageBuilder = (args: Record<string, string>) => GetPromptResult;

const builders: Record<string, PromptMessageBuilder> = {
  'ynab-pulse-check': () => buildPulseCheckMessages(),
  'ynab-monthly-review': (args) => buildMonthlyReviewMessages(args),
  'ynab-assign-money': () => buildAssignMoneyMessages(),
  'ynab-true-expenses': () => buildTrueExpensesMessages(),
  'ynab-overspending-triage': () => buildOverspendingTriageMessages(),
  'ynab-age-of-money': () => buildAgeOfMoneyMessages(),
  'ynab-reconcile-cleanup': () => buildReconcileCleanupMessages(),
};

/** Truncate and strip newlines from an untrusted prompt name before it's echoed back (e.g. in an error message). */
export function sanitizePromptName(name: string): string {
  return name.slice(0, 100).replace(/[\r\n]/g, '');
}

/**
 * Build the messages for a prompt call.
 */
export function getPromptMessages(name: string, args: Record<string, string>): GetPromptResult {
  // Guard against prototype pollution - only allow own properties
  if (!Object.prototype.hasOwnProperty.call(builders, name)) {
    throw new UnknownPromptError();
  }

  const builder = builders[name] as PromptMessageBuilder;
  return builder(args);
}
