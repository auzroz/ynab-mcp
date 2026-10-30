/**
 * Reconcile Cleanup Prompt
 *
 * Weekly hygiene pass: uncleared transactions and unused/sprawling
 * categories.
 */

import type { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export const reconcileCleanupPrompt: Prompt = {
  name: 'ynab-reconcile-cleanup',
  title: 'Reconcile Cleanup',
  description:
    'Runs the weekly housekeeping pass: flags uncleared transactions per account for reconciliation, and audits the budget for unused or overly-granular ("sprawl") categories worth merging or archiving. Use for "let\'s reconcile my accounts", "clean up my budget", "find categories I don\'t use", "check for uncleared transactions", or "audit my budget for clutter". Not for spending analysis or overspending remediation — purely data-integrity and structure hygiene.',
};

export function buildReconcileCleanupMessages(): { description: string; messages: PromptMessage[] } {
  return {
    description: 'Weekly reconciliation and category hygiene pass.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Run my weekly budget housekeeping pass.

Call these tools, in order:
1. ynab_reconciliation_helper — for each account, flagging the oldest pending uncleared transaction
2. ynab_unused_categories (months: 6)
3. ynab_category_balances (filter: "all") — to spot near-duplicate or empty groups

Then synthesize:
- Uncleared transactions by account: count and oldest pending date
- Unused categories (no activity in 6 months): names and current balance if any
- Sprawl candidates: similar or overlapping categories that could be merged

If I confirm any merges, use ynab_update_category_group to apply them — otherwise just report the findings.`,
        },
      },
    ],
  };
}
